import { useEffect, useState, type ReactElement, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Star, Trash2, X } from 'lucide-react'
import { ModelPicker } from './ModelPicker'
import {
  SCHEDULE_REASONING_EFFORT_IDS,
  WORKFLOW_INPUT_FIELD_TYPES,
  getModelProviderSettings,
  type AppSettingsV1,
  type WorkflowCodeCheckResult,
  type WorkflowCodeLanguage,
  type WorkflowConditionOperator,
  type WorkflowHttpMethod,
  type WorkflowInputFieldType,
  type WorkflowInputFieldV1,
  type WorkflowNodeRunResultV1,
  type WorkflowNodeV1,
  type WorkflowTriggerScheduleKind,
  type WorkflowWebhookMethod
} from '@shared/app-settings'

const WEBHOOK_METHODS: WorkflowWebhookMethod[] = ['ANY', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE']

const INPUT_CLASS =
  'w-full rounded-lg border border-ds-border bg-ds-card px-3 py-2 text-[13px] text-ds-ink outline-none focus:border-accent/40 focus:ring-1 focus:ring-accent/25'

const SCHEDULE_KINDS: WorkflowTriggerScheduleKind[] = ['manual', 'interval', 'daily', 'at', 'cron']
const HTTP_METHODS: WorkflowHttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
const CODE_PLACEHOLDERS: Record<WorkflowCodeLanguage, string> = {
  javascript: 'return { value: $json }',
  python: 'import sys, json\ndata = json.load(sys.stdin)\nprint(data.get("text", ""))',
  bash: 'echo "$WORKFLOW_TEXT" | tr a-z A-Z'
}
function buildWorkflowRunCurl(settings: AppSettingsV1, name: string): string {
  const port = settings.workflow.webhookPort
  const secret = settings.workflow.webhookSecret.trim()
  const lines = [
    `curl -X POST http://127.0.0.1:${port}/workflow/run \\`,
    `  -H "Content-Type: application/json" \\`
  ]
  if (secret) lines.push(`  -H "x-kun-secret: ${secret}" \\`)
  // Shell-escape single quotes in the JSON so a workflow name with a quote can't break out of the -d '...' arg.
  const payload = JSON.stringify({ workflow: name, input: '' }).replace(/'/g, "'\\''")
  lines.push(`  -d '${payload}'`)
  return lines.join('\n')
}

const CONDITION_OPERATORS: WorkflowConditionOperator[] = [
  'contains',
  'notContains',
  'equals',
  'notEquals',
  'startsWith',
  'endsWith',
  'isEmpty',
  'isNotEmpty',
  'gt',
  'gte',
  'lt',
  'lte'
]

type Props = {
  node: WorkflowNodeV1 | null
  settings: AppSettingsV1
  lastResult?: WorkflowNodeRunResultV1 | null
  onChange: (node: WorkflowNodeV1) => void
  onDelete: (nodeId: string) => void
  /** Save the current node as a reusable palette preset. */
  onSavePreset?: (node: WorkflowNodeV1, label: string) => void
  /** Current workflow name, used to render the local HTTP invocation example on the trigger. */
  workflowName?: string
}

function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: ReactNode
}): ReactElement {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12px] font-medium text-ds-muted">{label}</span>
      {children}
      {hint ? <span className="text-[11px] leading-4 text-ds-faint">{hint}</span> : null}
    </label>
  )
}

type CustomNode = Extract<WorkflowNodeV1, { type: 'custom' }>

/** Auto-generated form for a `custom` node, built from its module's field schema. */
function CustomNodeForm({
  node,
  settings,
  onChange
}: {
  node: CustomNode
  settings: AppSettingsV1
  onChange: (node: WorkflowNodeV1) => void
}): ReactElement {
  const { t } = useTranslation('common')
  const module = settings.workflow.modules.find((item) => item.id === node.config.moduleId)
  if (!module) {
    return <p className="text-[12px] leading-5 text-red-600">{t('workflowModuleMissing')}</p>
  }
  const setValue = (key: string, value: string): void =>
    onChange({ ...node, config: { ...node.config, values: { ...node.config.values, [key]: value } } })
  return (
    <>
      {module.description ? (
        <p className="text-[11.5px] leading-5 text-ds-faint">{module.description}</p>
      ) : null}
      {module.fields.length === 0 ? (
        <p className="text-[11.5px] leading-5 text-ds-faint">{t('workflowModuleNoFields')}</p>
      ) : null}
      {module.fields.map((field) => {
        const value = node.config.values[field.key] ?? field.defaultValue
        if (field.type === 'boolean') {
          return (
            <label key={field.key} className="flex items-center gap-2 text-[13px] text-ds-ink">
              <input
                type="checkbox"
                checked={value === 'true'}
                onChange={(event) => setValue(field.key, event.target.checked ? 'true' : 'false')}
              />
              {field.label || field.key}
            </label>
          )
        }
        return (
          <Field key={field.key} label={field.label || field.key}>
            {field.type === 'textarea' ? (
              <textarea
                className={`${INPUT_CLASS} min-h-[80px] resize-y`}
                value={value}
                placeholder={field.placeholder}
                onChange={(event) => setValue(field.key, event.target.value)}
              />
            ) : field.type === 'select' ? (
              <select className={INPUT_CLASS} value={value} onChange={(event) => setValue(field.key, event.target.value)}>
                {!field.options.includes(value) ? <option value={value}>{value || '—'}</option> : null}
                {field.options.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type={field.type === 'number' ? 'number' : 'text'}
                className={INPUT_CLASS}
                value={value}
                placeholder={field.placeholder}
                onChange={(event) => setValue(field.key, event.target.value)}
              />
            )}
          </Field>
        )
      })}
    </>
  )
}

/** Reusable typed-field editor — shared by the manual trigger's input schema and the Parameter Extractor. */
function InputFieldsEditor({
  fields,
  onChange
}: {
  fields: WorkflowInputFieldV1[]
  onChange: (next: WorkflowInputFieldV1[]) => void
}): ReactElement {
  const { t } = useTranslation('common')
  const addField = (): void =>
    onChange([
      ...fields,
      { key: `field${fields.length + 1}`, label: '', type: 'text', required: false, options: [], defaultValue: '', description: '' }
    ])
  return (
    <>
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-medium text-ds-muted">{t('workflowInputSchema')}</span>
        <button
          type="button"
          onClick={addField}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11.5px] font-medium text-accent transition hover:bg-accent/10"
        >
          <Plus className="h-3 w-3" strokeWidth={2} />
          {t('workflowInputAddField')}
        </button>
      </div>
      {fields.length === 0 ? (
        <p className="text-[11px] leading-4 text-ds-faint">{t('workflowInputSchemaHint')}</p>
      ) : (
        fields.map((field, index) => {
          const update = (patch: Partial<WorkflowInputFieldV1>): void =>
            onChange(fields.map((item, i) => (i === index ? { ...item, ...patch } : item)))
          return (
            <div key={index} className="flex flex-col gap-2 rounded-lg border border-ds-border p-2.5">
              <div className="flex items-center gap-2">
                <input
                  className={INPUT_CLASS}
                  value={field.key}
                  placeholder={t('workflowInputKey')}
                  onChange={(event) => update({ key: event.target.value })}
                />
                <select
                  className={`${INPUT_CLASS} w-28 shrink-0`}
                  value={field.type}
                  onChange={(event) => update({ type: event.target.value as WorkflowInputFieldType })}
                >
                  {WORKFLOW_INPUT_FIELD_TYPES.map((fieldType) => (
                    <option key={fieldType} value={fieldType}>
                      {t(`workflowInputType_${fieldType}`)}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => onChange(fields.filter((_, i) => i !== index))}
                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ds-faint transition hover:bg-red-500/10 hover:text-red-600"
                  aria-label={t('workflowInputRemoveField')}
                >
                  <X className="h-3.5 w-3.5" strokeWidth={2} />
                </button>
              </div>
              <div className="flex items-center gap-2">
                <input
                  className={INPUT_CLASS}
                  value={field.label}
                  placeholder={t('workflowInputLabel')}
                  onChange={(event) => update({ label: event.target.value })}
                />
                <input
                  className={INPUT_CLASS}
                  value={field.defaultValue}
                  placeholder={t('workflowInputDefault')}
                  onChange={(event) => update({ defaultValue: event.target.value })}
                />
              </div>
              {field.type === 'select' ? (
                <input
                  className={INPUT_CLASS}
                  value={field.options.join(', ')}
                  placeholder={t('workflowModuleFieldOptions')}
                  onChange={(event) =>
                    update({
                      options: event.target.value
                        .split(',')
                        .map((option) => option.trim())
                        .filter((option) => option.length > 0)
                    })
                  }
                />
              ) : null}
              <label className="flex items-center gap-2 text-[12px] text-ds-muted">
                <input
                  type="checkbox"
                  checked={field.required}
                  onChange={(event) => update({ required: event.target.checked })}
                />
                {t('workflowInputRequired')}
              </label>
            </div>
          )
        })
      )}
    </>
  )
}

export function NodeConfigPanel({
  node,
  settings,
  lastResult,
  onChange,
  onDelete,
  onSavePreset,
  workflowName
}: Props): ReactElement {
  const { t } = useTranslation('common')

  const [presetLabel, setPresetLabel] = useState('')
  const [presetSaved, setPresetSaved] = useState(false)
  // Debounced editor-time syntax check for the Code node (runs in the main process).
  const [codeCheck, setCodeCheck] = useState<WorkflowCodeCheckResult | null>(null)
  const codeValue = node && node.type === 'code' ? node.config.code : ''
  const codeLanguage = node && node.type === 'code' ? node.config.language : 'javascript'
  useEffect(() => {
    if (node?.type !== 'code' || !codeValue.trim()) {
      setCodeCheck(null)
      return
    }
    let cancelled = false
    const handle = setTimeout(() => {
      window.kunGui
        .checkWorkflowCode(codeLanguage, codeValue)
        .then((result) => {
          if (!cancelled) setCodeCheck(result)
        })
        .catch(() => {
          if (!cancelled) setCodeCheck(null)
        })
    }, 500)
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [node?.type, codeValue, codeLanguage])

  if (!node) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-[13px] text-ds-faint">
        {t('workflowNoSelection')}
      </div>
    )
  }

  const providers = getModelProviderSettings(settings).providers

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-ds-border px-4 py-3">
        <h2 className="text-[13px] font-semibold text-ds-ink">
          {t(`workflowNode_${node.type}`)}
        </h2>
        <button
          type="button"
          onClick={() => onDelete(node.id)}
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-ds-border text-ds-muted transition hover:bg-red-500/10 hover:text-red-600"
          title={t('workflowDeleteNode')}
          aria-label={t('workflowDeleteNode')}
        >
          <Trash2 className="h-4 w-4" strokeWidth={1.8} />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
        <Field label={t('workflowNodeName')}>
          <input
            className={INPUT_CLASS}
            value={node.name}
            placeholder={t(`workflowNode_${node.type}`)}
            onChange={(event) => onChange({ ...node, name: event.target.value })}
          />
        </Field>

        {node.type === 'manual-trigger' || node.type === 'schedule-trigger' || node.type === 'webhook-trigger' ? (
          <Field label={t('workflowTriggerWorkspace')}>
            <input
              className={INPUT_CLASS}
              value={node.config.workspaceRoot ?? ''}
              placeholder={settings.workspaceRoot || '~/project'}
              onChange={(event) =>
                onChange({
                  ...node,
                  config: { ...node.config, workspaceRoot: event.target.value }
                } as WorkflowNodeV1)
              }
            />
            <span className="mt-1 text-[11px] leading-4 text-ds-faint">{t('workflowTriggerWorkspaceHint')}</span>
          </Field>
        ) : null}

        {node.type === 'manual-trigger' ? (
          <div className="flex flex-col gap-2 border-t border-ds-border pt-3">
            <InputFieldsEditor
              fields={node.config.inputSchema ?? []}
              onChange={(next) => onChange({ ...node, config: { ...node.config, inputSchema: next } })}
            />
          </div>
        ) : null}

        {node.type === 'manual-trigger' && workflowName ? (
          <div className="flex flex-col gap-1.5 border-t border-ds-border pt-3">
            <span className="text-[12px] font-medium text-ds-muted">{t('workflowLocalApi')}</span>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-ds-subtle px-3 py-2 font-mono text-[11px] leading-5 text-ds-muted">
              {buildWorkflowRunCurl(settings, workflowName)}
            </pre>
            <button
              type="button"
              onClick={() => void navigator.clipboard?.writeText(buildWorkflowRunCurl(settings, workflowName))}
              className="self-start rounded-md border border-ds-border px-2 py-1 text-[11.5px] font-medium text-ds-ink transition hover:bg-ds-hover"
            >
              {t('workflowLocalApiCopy')}
            </button>
            <span className="text-[11px] leading-4 text-ds-faint">{t('workflowLocalApiHint')}</span>
          </div>
        ) : null}

        {node.type === 'schedule-trigger' ? (
          <>
            <Field label={t('workflowScheduleKind')}>
              <select
                className={INPUT_CLASS}
                value={node.config.schedule.kind}
                onChange={(event) =>
                  onChange({
                    ...node,
                    config: {
                      schedule: {
                        ...node.config.schedule,
                        kind: event.target.value as WorkflowTriggerScheduleKind
                      }
                    }
                  })
                }
              >
                {SCHEDULE_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {t(`workflowScheduleKind_${kind}`)}
                  </option>
                ))}
              </select>
            </Field>
            {node.config.schedule.kind === 'interval' ? (
              <Field label={t('workflowEveryMinutes')}>
                <input
                  type="number"
                  min={1}
                  className={INPUT_CLASS}
                  value={node.config.schedule.everyMinutes}
                  onChange={(event) =>
                    onChange({
                      ...node,
                      config: {
                        schedule: { ...node.config.schedule, everyMinutes: Number(event.target.value) || 1 }
                      }
                    })
                  }
                />
              </Field>
            ) : null}
            {node.config.schedule.kind === 'daily' ? (
              <Field label={t('workflowTimeOfDay')}>
                <input
                  type="time"
                  className={INPUT_CLASS}
                  value={node.config.schedule.timeOfDay}
                  onChange={(event) =>
                    onChange({
                      ...node,
                      config: { schedule: { ...node.config.schedule, timeOfDay: event.target.value } }
                    })
                  }
                />
              </Field>
            ) : null}
            {node.config.schedule.kind === 'at' ? (
              <Field label={t('workflowAtTime')}>
                <input
                  type="datetime-local"
                  className={INPUT_CLASS}
                  value={node.config.schedule.atTime ? node.config.schedule.atTime.slice(0, 16) : ''}
                  onChange={(event) =>
                    onChange({
                      ...node,
                      config: {
                        schedule: {
                          ...node.config.schedule,
                          atTime: event.target.value ? new Date(event.target.value).toISOString() : ''
                        }
                      }
                    })
                  }
                />
              </Field>
            ) : null}
            {node.config.schedule.kind === 'cron' ? (
              <Field label={t('workflowCron')}>
                <input
                  className={INPUT_CLASS}
                  value={node.config.schedule.cron}
                  placeholder={t('workflowCronPlaceholder')}
                  onChange={(event) =>
                    onChange({
                      ...node,
                      config: { schedule: { ...node.config.schedule, cron: event.target.value } }
                    })
                  }
                />
              </Field>
            ) : null}
          </>
        ) : null}

        {node.type === 'webhook-trigger' ? (
          <>
            <Field label={t('workflowWebhookMethod')}>
              <select
                className={INPUT_CLASS}
                value={node.config.method}
                onChange={(event) =>
                  onChange({ ...node, config: { ...node.config, method: event.target.value as WorkflowWebhookMethod } })
                }
              >
                {WEBHOOK_METHODS.map((method) => (
                  <option key={method} value={method}>
                    {method}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('workflowWebhookPath')}>
              <input
                className={INPUT_CLASS}
                value={node.config.path}
                placeholder="/my-hook"
                onChange={(event) => onChange({ ...node, config: { ...node.config, path: event.target.value } })}
              />
            </Field>
            <div className="flex flex-col gap-1.5">
              <span className="text-[12px] font-medium text-ds-muted">{t('workflowWebhookUrl')}</span>
              <code className="select-all break-all rounded-lg bg-ds-subtle px-3 py-2 text-[11.5px] text-ds-muted">
                {`http://127.0.0.1:${settings.workflow.webhookPort}${node.config.path}`}
              </code>
            </div>
          </>
        ) : null}

        {node.type === 'ai-agent' ? (
          <>
            <Field label={t('workflowPrompt')}>
              <textarea
                className={`${INPUT_CLASS} min-h-[120px] resize-y`}
                value={node.config.prompt}
                placeholder={t('workflowPromptPlaceholder', { token: '{{text}}' })}
                onChange={(event) =>
                  onChange({ ...node, config: { ...node.config, prompt: event.target.value } })
                }
              />
            </Field>
            <ModelPicker
              providers={providers}
              providerId={node.config.providerId}
              model={node.config.model}
              onChange={({ providerId, model }) => onChange({ ...node, config: { ...node.config, providerId, model } })}
            />
            <Field label={t('scheduleReasoning')}>
              <select
                className={INPUT_CLASS}
                value={node.config.reasoningEffort}
                onChange={(event) =>
                  onChange({
                    ...node,
                    config: { ...node.config, reasoningEffort: event.target.value as typeof node.config.reasoningEffort }
                  })
                }
              >
                {SCHEDULE_REASONING_EFFORT_IDS.map((effort) => (
                  <option key={effort} value={effort}>
                    {t(`scheduleReasoning_${effort}`)}
                  </option>
                ))}
              </select>
            </Field>
          </>
        ) : null}

        {node.type === 'generate-image' ? (
          <>
            <Field label={t('workflowImagePrompt')}>
              <textarea
                className={`${INPUT_CLASS} min-h-[100px] resize-y`}
                value={node.config.prompt}
                placeholder={t('workflowImagePromptPlaceholder', { token: '{{text}}' })}
                onChange={(event) => onChange({ ...node, config: { ...node.config, prompt: event.target.value } })}
              />
            </Field>
            <ModelPicker
              providers={providers}
              providerId={node.config.providerId}
              model={node.config.model}
              onChange={({ providerId, model }) => onChange({ ...node, config: { ...node.config, providerId, model } })}
              providerFilter={(provider) => Boolean(provider.image)}
              modelsOf={(provider) => provider.image?.models ?? []}
              modelLabel={t('workflowImageModel')}
            />
            <Field label={t('workflowImageSize')}>
              <input
                className={INPUT_CLASS}
                value={node.config.size}
                placeholder="1024x1024"
                onChange={(event) => onChange({ ...node, config: { ...node.config, size: event.target.value } })}
              />
            </Field>
            <Field label={t('workflowImageOutputDir')}>
              <input
                className={INPUT_CLASS}
                value={node.config.outputDir}
                placeholder={t('workflowImageOutputDirPlaceholder')}
                onChange={(event) => onChange({ ...node, config: { ...node.config, outputDir: event.target.value } })}
              />
            </Field>
            <p className="text-[11.5px] leading-5 text-ds-faint">{t('workflowImageHint')}</p>
          </>
        ) : null}

        {node.type === 'condition' ? (
          <>
            <Field label={t('workflowConditionLeft')}>
              <input
                className={INPUT_CLASS}
                value={node.config.leftExpr}
                placeholder={t('workflowConditionLeftPlaceholder')}
                onChange={(event) =>
                  onChange({ ...node, config: { ...node.config, leftExpr: event.target.value } })
                }
              />
            </Field>
            <Field label={t('workflowConditionOperator')}>
              <select
                className={INPUT_CLASS}
                value={node.config.operator}
                onChange={(event) =>
                  onChange({
                    ...node,
                    config: { ...node.config, operator: event.target.value as WorkflowConditionOperator }
                  })
                }
              >
                {CONDITION_OPERATORS.map((operator) => (
                  <option key={operator} value={operator}>
                    {t(`workflowOp_${operator}`)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('workflowConditionValue')}>
              <input
                className={INPUT_CLASS}
                value={node.config.rightValue}
                onChange={(event) =>
                  onChange({ ...node, config: { ...node.config, rightValue: event.target.value } })
                }
              />
            </Field>
            <label className="flex items-center gap-2 text-[13px] text-ds-ink">
              <input
                type="checkbox"
                checked={node.config.caseSensitive}
                onChange={(event) =>
                  onChange({ ...node, config: { ...node.config, caseSensitive: event.target.checked } })
                }
              />
              {t('workflowConditionCaseSensitive')}
            </label>
          </>
        ) : null}

        {node.type === 'set-fields' ? (
          <>
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-[12px] font-medium text-ds-muted">{t('workflowFields')}</span>
                <button
                  type="button"
                  className="text-[12px] font-medium text-accent hover:underline"
                  onClick={() =>
                    onChange({ ...node, config: { ...node.config, fields: [...node.config.fields, { key: '', value: '' }] } })
                  }
                >
                  + {t('workflowAddField')}
                </button>
              </div>
              {node.config.fields.map((field, index) => (
                <div key={index} className="flex items-center gap-2">
                  <input
                    className={INPUT_CLASS}
                    placeholder={t('workflowFieldKey')}
                    value={field.key}
                    onChange={(event) => {
                      const fields = node.config.fields.map((item, idx) =>
                        idx === index ? { ...item, key: event.target.value } : item
                      )
                      onChange({ ...node, config: { ...node.config, fields } })
                    }}
                  />
                  <input
                    className={INPUT_CLASS}
                    placeholder={t('workflowFieldValue')}
                    value={field.value}
                    onChange={(event) => {
                      const fields = node.config.fields.map((item, idx) =>
                        idx === index ? { ...item, value: event.target.value } : item
                      )
                      onChange({ ...node, config: { ...node.config, fields } })
                    }}
                  />
                  <button
                    type="button"
                    className="shrink-0 text-ds-faint hover:text-red-500"
                    onClick={() => {
                      const fields = node.config.fields.filter((_, idx) => idx !== index)
                      onChange({ ...node, config: { ...node.config, fields } })
                    }}
                    aria-label={t('workflowDeleteNode')}
                  >
                    <Trash2 className="h-3.5 w-3.5" strokeWidth={1.8} />
                  </button>
                </div>
              ))}
            </div>
            <label className="flex items-center gap-2 text-[13px] text-ds-ink">
              <input
                type="checkbox"
                checked={node.config.keepIncoming}
                onChange={(event) =>
                  onChange({ ...node, config: { ...node.config, keepIncoming: event.target.checked } })
                }
              />
              {t('workflowKeepIncoming')}
            </label>
          </>
        ) : null}

        {node.type === 'http-request' ? (
          <>
            <Field label={t('workflowHttpMethod')}>
              <select
                className={INPUT_CLASS}
                value={node.config.method}
                onChange={(event) =>
                  onChange({ ...node, config: { ...node.config, method: event.target.value as WorkflowHttpMethod } })
                }
              >
                {HTTP_METHODS.map((method) => (
                  <option key={method} value={method}>
                    {method}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('workflowHttpUrl')}>
              <input
                className={INPUT_CLASS}
                value={node.config.url}
                placeholder="https://"
                onChange={(event) =>
                  onChange({ ...node, config: { ...node.config, url: event.target.value } })
                }
              />
            </Field>
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="text-[12px] font-medium text-ds-muted">{t('workflowHttpHeaders')}</span>
                <button
                  type="button"
                  className="text-[12px] font-medium text-accent hover:underline"
                  onClick={() =>
                    onChange({
                      ...node,
                      config: { ...node.config, headers: [...node.config.headers, { key: '', value: '' }] }
                    })
                  }
                >
                  + {t('workflowHttpAddHeader')}
                </button>
              </div>
              {node.config.headers.map((header, index) => (
                <div key={index} className="flex items-center gap-2">
                  <input
                    className={INPUT_CLASS}
                    placeholder={t('workflowHeaderKey')}
                    value={header.key}
                    onChange={(event) => {
                      const headers = node.config.headers.map((item, idx) =>
                        idx === index ? { ...item, key: event.target.value } : item
                      )
                      onChange({ ...node, config: { ...node.config, headers } })
                    }}
                  />
                  <input
                    className={INPUT_CLASS}
                    placeholder={t('workflowHeaderValue')}
                    value={header.value}
                    onChange={(event) => {
                      const headers = node.config.headers.map((item, idx) =>
                        idx === index ? { ...item, value: event.target.value } : item
                      )
                      onChange({ ...node, config: { ...node.config, headers } })
                    }}
                  />
                  <button
                    type="button"
                    className="shrink-0 text-ds-faint hover:text-red-500"
                    onClick={() => {
                      const headers = node.config.headers.filter((_, idx) => idx !== index)
                      onChange({ ...node, config: { ...node.config, headers } })
                    }}
                    aria-label={t('workflowDeleteNode')}
                  >
                    <Trash2 className="h-3.5 w-3.5" strokeWidth={1.8} />
                  </button>
                </div>
              ))}
            </div>
            <Field label={t('workflowHttpBody')}>
              <textarea
                className={`${INPUT_CLASS} min-h-[80px] resize-y font-mono`}
                value={node.config.body}
                onChange={(event) =>
                  onChange({ ...node, config: { ...node.config, body: event.target.value } })
                }
              />
            </Field>
            <label className="flex items-center gap-2 text-[13px] text-ds-ink">
              <input
                type="checkbox"
                checked={node.config.parseJson}
                onChange={(event) =>
                  onChange({ ...node, config: { ...node.config, parseJson: event.target.checked } })
                }
              />
              {t('workflowHttpParseJson')}
            </label>
          </>
        ) : null}

        {node.type === 'switch' ? (
          <>
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <span className="text-[12px] font-medium text-ds-muted">{t('workflowSwitchRules')}</span>
                <button
                  type="button"
                  className="text-[12px] font-medium text-accent hover:underline"
                  onClick={() =>
                    onChange({
                      ...node,
                      config: {
                        ...node.config,
                        rules: [
                          ...node.config.rules,
                          { leftExpr: '', operator: 'contains', rightValue: '', caseSensitive: false }
                        ]
                      }
                    })
                  }
                >
                  + {t('workflowAddRule')}
                </button>
              </div>
              {node.config.rules.map((rule, index) => (
                <div key={index} className="flex flex-col gap-1.5 rounded-lg border border-ds-border p-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-medium text-ds-faint">
                      {t('workflowSwitchCase', { index: index + 1 })}
                    </span>
                    <button
                      type="button"
                      className="text-ds-faint hover:text-red-500"
                      aria-label={t('workflowDeleteNode')}
                      onClick={() =>
                        onChange({
                          ...node,
                          config: { ...node.config, rules: node.config.rules.filter((_, idx) => idx !== index) }
                        })
                      }
                    >
                      <Trash2 className="h-3.5 w-3.5" strokeWidth={1.8} />
                    </button>
                  </div>
                  <input
                    className={INPUT_CLASS}
                    placeholder={t('workflowConditionLeftPlaceholder')}
                    value={rule.leftExpr}
                    onChange={(event) =>
                      onChange({
                        ...node,
                        config: {
                          ...node.config,
                          rules: node.config.rules.map((item, idx) =>
                            idx === index ? { ...item, leftExpr: event.target.value } : item
                          )
                        }
                      })
                    }
                  />
                  <select
                    className={INPUT_CLASS}
                    value={rule.operator}
                    onChange={(event) =>
                      onChange({
                        ...node,
                        config: {
                          ...node.config,
                          rules: node.config.rules.map((item, idx) =>
                            idx === index ? { ...item, operator: event.target.value as WorkflowConditionOperator } : item
                          )
                        }
                      })
                    }
                  >
                    {CONDITION_OPERATORS.map((operator) => (
                      <option key={operator} value={operator}>
                        {t(`workflowOp_${operator}`)}
                      </option>
                    ))}
                  </select>
                  <input
                    className={INPUT_CLASS}
                    placeholder={t('workflowConditionValue')}
                    value={rule.rightValue}
                    onChange={(event) =>
                      onChange({
                        ...node,
                        config: {
                          ...node.config,
                          rules: node.config.rules.map((item, idx) =>
                            idx === index ? { ...item, rightValue: event.target.value } : item
                          )
                        }
                      })
                    }
                  />
                </div>
              ))}
            </div>
            <label className="flex items-center gap-2 text-[13px] text-ds-ink">
              <input
                type="checkbox"
                checked={node.config.fallback}
                onChange={(event) => onChange({ ...node, config: { ...node.config, fallback: event.target.checked } })}
              />
              {t('workflowSwitchFallback')}
            </label>
          </>
        ) : null}

        {node.type === 'code' ? (
          <>
            <Field label={t('workflowCodeLanguage')}>
              <select
                className={INPUT_CLASS}
                value={node.config.language}
                onChange={(event) =>
                  onChange({
                    ...node,
                    config: {
                      ...node.config,
                      language:
                        event.target.value === 'python' || event.target.value === 'bash'
                          ? event.target.value
                          : 'javascript'
                    }
                  })
                }
              >
                <option value="javascript">JavaScript</option>
                <option value="python">Python</option>
                <option value="bash">Shell (bash)</option>
              </select>
            </Field>
            <Field label={t('workflowCode')}>
              <textarea
                className={`${INPUT_CLASS} min-h-[160px] resize-y font-mono`}
                value={node.config.code}
                placeholder={CODE_PLACEHOLDERS[node.config.language]}
                onChange={(event) => onChange({ ...node, config: { ...node.config, code: event.target.value } })}
              />
            </Field>
            <p className="text-[11.5px] leading-5 text-ds-faint">
              {t(node.config.language === 'javascript' ? 'workflowCodeHintJs' : 'workflowCodeHintCmd')}
            </p>
            {codeCheck?.status === 'error' ? (
              <div className="rounded-lg border border-red-500/40 bg-red-500/5 px-3 py-2">
                <div className="text-[11.5px] font-semibold text-red-600">{t('workflowCodeSyntaxError')}</div>
                <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-4 text-red-600/90">
                  {codeCheck.message}
                </pre>
              </div>
            ) : codeCheck?.status === 'ok' ? (
              <div className="text-[11.5px] font-medium text-emerald-600">✓ {t('workflowCodeSyntaxOk')}</div>
            ) : codeCheck?.status === 'unavailable' ? (
              <div className="text-[11.5px] text-ds-faint">{codeCheck.message}</div>
            ) : null}
          </>
        ) : null}

        {node.type === 'subworkflow' ? (
          <Field label={t('workflowSubWorkflowTarget')}>
            <select
              className={INPUT_CLASS}
              value={node.config.workflowId}
              onChange={(event) => onChange({ ...node, config: { workflowId: event.target.value } })}
            >
              <option value="">{t('workflowSubWorkflowNone')}</option>
              {settings.workflow.workflows.map((workflow) => (
                <option key={workflow.id} value={workflow.id}>
                  {workflow.name || t('workflowUntitled')}
                </option>
              ))}
            </select>
          </Field>
        ) : null}

        {node.type === 'loop' ? (
          <>
            <Field label={t('workflowLoopBody')}>
              <select
                className={INPUT_CLASS}
                value={node.config.workflowId}
                onChange={(event) => onChange({ ...node, config: { ...node.config, workflowId: event.target.value } })}
              >
                <option value="">{t('workflowSubWorkflowNone')}</option>
                {settings.workflow.workflows.map((workflow) => (
                  <option key={workflow.id} value={workflow.id}>
                    {workflow.name || t('workflowUntitled')}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('workflowLoopMax')}>
              <input
                type="number"
                min={1}
                max={100}
                className={INPUT_CLASS}
                value={node.config.maxIterations}
                onChange={(event) =>
                  onChange({
                    ...node,
                    config: { ...node.config, maxIterations: Math.max(1, Math.min(100, Number(event.target.value) || 1)) }
                  })
                }
              />
            </Field>
            <span className="text-[12px] font-medium text-ds-muted">{t('workflowLoopStopWhen')}</span>
            <input
              className={INPUT_CLASS}
              placeholder={t('workflowConditionLeftPlaceholder')}
              value={node.config.leftExpr}
              onChange={(event) => onChange({ ...node, config: { ...node.config, leftExpr: event.target.value } })}
            />
            <select
              className={INPUT_CLASS}
              value={node.config.operator}
              onChange={(event) =>
                onChange({ ...node, config: { ...node.config, operator: event.target.value as WorkflowConditionOperator } })
              }
            >
              {CONDITION_OPERATORS.map((operator) => (
                <option key={operator} value={operator}>
                  {t(`workflowOp_${operator}`)}
                </option>
              ))}
            </select>
            <input
              className={INPUT_CLASS}
              placeholder={t('workflowConditionValue')}
              value={node.config.rightValue}
              onChange={(event) => onChange({ ...node, config: { ...node.config, rightValue: event.target.value } })}
            />
          </>
        ) : null}

        {node.type === 'merge' ? (
          <Field label={t('workflowMergeMode')}>
            <select
              className={INPUT_CLASS}
              value={node.config.mode}
              onChange={(event) =>
                onChange({ ...node, config: { mode: event.target.value === 'object' ? 'object' : 'array' } })
              }
            >
              <option value="array">{t('workflowMergeArray')}</option>
              <option value="object">{t('workflowMergeObject')}</option>
            </select>
          </Field>
        ) : null}

        {node.type === 'filter' ? (
          <>
            <p className="text-[11.5px] leading-5 text-ds-faint">{t('workflowFilterHint')}</p>
            <Field label={t('workflowConditionLeft')}>
              <input
                className={INPUT_CLASS}
                value={node.config.leftExpr}
                placeholder={t('workflowConditionLeftPlaceholder')}
                onChange={(event) => onChange({ ...node, config: { ...node.config, leftExpr: event.target.value } })}
              />
            </Field>
            <Field label={t('workflowConditionOperator')}>
              <select
                className={INPUT_CLASS}
                value={node.config.operator}
                onChange={(event) =>
                  onChange({ ...node, config: { ...node.config, operator: event.target.value as WorkflowConditionOperator } })
                }
              >
                {CONDITION_OPERATORS.map((operator) => (
                  <option key={operator} value={operator}>
                    {t(`workflowOp_${operator}`)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('workflowConditionValue')}>
              <input
                className={INPUT_CLASS}
                value={node.config.rightValue}
                onChange={(event) => onChange({ ...node, config: { ...node.config, rightValue: event.target.value } })}
              />
            </Field>
          </>
        ) : null}

        {node.type === 'sort' ? (
          <>
            <p className="text-[11.5px] leading-5 text-ds-faint">{t('workflowArrayHint')}</p>
            <Field label={t('workflowSortField')}>
              <input
                className={INPUT_CLASS}
                value={node.config.field}
                placeholder="value / user.name"
                onChange={(event) => onChange({ ...node, config: { ...node.config, field: event.target.value } })}
              />
            </Field>
            <Field label={t('workflowSortOrder')}>
              <select
                className={INPUT_CLASS}
                value={node.config.order}
                onChange={(event) =>
                  onChange({ ...node, config: { ...node.config, order: event.target.value === 'desc' ? 'desc' : 'asc' } })
                }
              >
                <option value="asc">{t('workflowSortAsc')}</option>
                <option value="desc">{t('workflowSortDesc')}</option>
              </select>
            </Field>
            <label className="flex items-center gap-2 text-[13px] text-ds-ink">
              <input
                type="checkbox"
                checked={node.config.numeric}
                onChange={(event) => onChange({ ...node, config: { ...node.config, numeric: event.target.checked } })}
              />
              {t('workflowSortNumeric')}
            </label>
          </>
        ) : null}

        {node.type === 'limit' ? (
          <>
            <p className="text-[11.5px] leading-5 text-ds-faint">{t('workflowArrayHint')}</p>
            <Field label={t('workflowLimitCount')}>
              <input
                type="number"
                min={1}
                className={INPUT_CLASS}
                value={node.config.count}
                onChange={(event) =>
                  onChange({ ...node, config: { ...node.config, count: Math.max(1, Number(event.target.value) || 1) } })
                }
              />
            </Field>
            <Field label={t('workflowLimitFrom')}>
              <select
                className={INPUT_CLASS}
                value={node.config.from}
                onChange={(event) =>
                  onChange({ ...node, config: { ...node.config, from: event.target.value === 'last' ? 'last' : 'first' } })
                }
              >
                <option value="first">{t('workflowLimitFirst')}</option>
                <option value="last">{t('workflowLimitLast')}</option>
              </select>
            </Field>
          </>
        ) : null}

        {node.type === 'aggregate' ? (
          <>
            <p className="text-[11.5px] leading-5 text-ds-faint">{t('workflowArrayHint')}</p>
            <Field label={t('workflowAggregateMode')}>
              <select
                className={INPUT_CLASS}
                value={node.config.mode}
                onChange={(event) => {
                  const mode = event.target.value
                  onChange({
                    ...node,
                    config: {
                      ...node.config,
                      mode: mode === 'sum' || mode === 'collect' || mode === 'join' ? mode : 'count'
                    }
                  })
                }}
              >
                <option value="count">{t('workflowAggCount')}</option>
                <option value="sum">{t('workflowAggSum')}</option>
                <option value="collect">{t('workflowAggCollect')}</option>
                <option value="join">{t('workflowAggJoin')}</option>
              </select>
            </Field>
            {node.config.mode !== 'count' ? (
              <Field label={t('workflowAggregateField')}>
                <input
                  className={INPUT_CLASS}
                  value={node.config.field}
                  placeholder="value / price"
                  onChange={(event) => onChange({ ...node, config: { ...node.config, field: event.target.value } })}
                />
              </Field>
            ) : null}
            {node.config.mode === 'join' ? (
              <Field label={t('workflowAggregateSeparator')}>
                <input
                  className={INPUT_CLASS}
                  value={node.config.separator}
                  onChange={(event) => onChange({ ...node, config: { ...node.config, separator: event.target.value } })}
                />
              </Field>
            ) : null}
          </>
        ) : null}

        {node.type === 'delay' ? (
          <Field label={t('workflowDelaySeconds')}>
            <input
              type="number"
              min={0}
              className={INPUT_CLASS}
              value={Math.round(node.config.delayMs / 1000)}
              onChange={(event) =>
                onChange({
                  ...node,
                  config: { delayMs: Math.max(0, Number(event.target.value) || 0) * 1000 }
                })
              }
            />
          </Field>
        ) : null}

        {node.type === 'template' ? (
          <>
            <Field label={t('workflowTemplate')}>
              <textarea
                className={`${INPUT_CLASS} min-h-[120px] resize-y font-mono`}
                value={node.config.template}
                placeholder={'{{json.title}} — {{text}}'}
                onChange={(event) => onChange({ ...node, config: { ...node.config, template: event.target.value } })}
              />
            </Field>
            <Field label={t('workflowTemplateOutput')}>
              <select
                className={INPUT_CLASS}
                value={node.config.outputMode}
                onChange={(event) =>
                  onChange({
                    ...node,
                    config: { ...node.config, outputMode: event.target.value === 'json' ? 'json' : 'text' }
                  })
                }
              >
                <option value="text">{t('workflowTemplateOutputText')}</option>
                <option value="json">{t('workflowTemplateOutputJson')}</option>
              </select>
            </Field>
            <p className="text-[11.5px] leading-5 text-ds-faint">{t('workflowTemplateHint')}</p>
          </>
        ) : null}

        {node.type === 'json' ? (
          <>
            <Field label={t('workflowJsonMode')}>
              <select
                className={INPUT_CLASS}
                value={node.config.mode}
                onChange={(event) =>
                  onChange({
                    ...node,
                    config: { ...node.config, mode: event.target.value === 'stringify' ? 'stringify' : 'parse' }
                  })
                }
              >
                <option value="parse">{t('workflowJsonParse')}</option>
                <option value="stringify">{t('workflowJsonStringify')}</option>
              </select>
            </Field>
            {node.config.mode === 'parse' ? (
              <label className="flex items-center gap-2 text-[13px] text-ds-ink">
                <input
                  type="checkbox"
                  checked={node.config.strict}
                  onChange={(event) => onChange({ ...node, config: { ...node.config, strict: event.target.checked } })}
                />
                {t('workflowJsonStrict')}
              </label>
            ) : null}
            <p className="text-[11.5px] leading-5 text-ds-faint">{t('workflowJsonHint')}</p>
          </>
        ) : null}

        {node.type === 'output' ? (
          <>
            <p className="text-[11.5px] leading-5 text-ds-faint">{t('workflowOutputHint')}</p>
            <Field label={t('workflowOutputMode')}>
              <select
                className={INPUT_CLASS}
                value={node.config.mode}
                onChange={(event) => {
                  const value = event.target.value
                  onChange({
                    ...node,
                    config: { ...node.config, mode: value === 'text' || value === 'json' ? value : 'auto' }
                  })
                }}
              >
                <option value="auto">{t('workflowOutputModeAuto')}</option>
                <option value="text">{t('workflowOutputModeText')}</option>
                <option value="json">{t('workflowOutputModeJson')}</option>
              </select>
            </Field>
            {node.config.mode === 'text' ? (
              <Field label={t('workflowOutputText')}>
                <textarea
                  className={`${INPUT_CLASS} min-h-[100px] resize-y font-mono`}
                  value={node.config.textTemplate}
                  placeholder={'{{text}}'}
                  onChange={(event) =>
                    onChange({ ...node, config: { ...node.config, textTemplate: event.target.value } })
                  }
                />
              </Field>
            ) : null}
            {node.config.mode === 'json' ? (
              <Field label={t('workflowOutputJsonPath')}>
                <input
                  className={INPUT_CLASS}
                  value={node.config.jsonPath}
                  placeholder="data.results"
                  onChange={(event) => onChange({ ...node, config: { ...node.config, jsonPath: event.target.value } })}
                />
              </Field>
            ) : null}
          </>
        ) : null}

        {node.type === 'parameter-extractor' ? (
          <>
            <Field label={t('workflowExtractSource')} hint={t('workflowExtractSourceHint')}>
              <input
                className={INPUT_CLASS}
                value={node.config.source}
                placeholder="{{text}}"
                onChange={(event) => onChange({ ...node, config: { ...node.config, source: event.target.value } })}
              />
            </Field>
            <Field label={t('workflowExtractInstruction')}>
              <textarea
                className={`${INPUT_CLASS} min-h-[72px] resize-y`}
                value={node.config.instruction}
                placeholder={t('workflowExtractInstructionPlaceholder')}
                onChange={(event) =>
                  onChange({ ...node, config: { ...node.config, instruction: event.target.value } })
                }
              />
            </Field>
            <div className="flex flex-col gap-2 border-t border-ds-border pt-3">
              <InputFieldsEditor
                fields={node.config.fields}
                onChange={(next) => onChange({ ...node, config: { ...node.config, fields: next } })}
              />
            </div>
            <ModelPicker
              providers={providers}
              providerId={node.config.providerId}
              model={node.config.model}
              onChange={({ providerId, model }) => onChange({ ...node, config: { ...node.config, providerId, model } })}
            />
            <Field label={t('scheduleReasoning')}>
              <select
                className={INPUT_CLASS}
                value={node.config.reasoningEffort}
                onChange={(event) =>
                  onChange({
                    ...node,
                    config: { ...node.config, reasoningEffort: event.target.value as typeof node.config.reasoningEffort }
                  })
                }
              >
                {SCHEDULE_REASONING_EFFORT_IDS.map((effort) => (
                  <option key={effort} value={effort}>
                    {t(`scheduleReasoning_${effort}`)}
                  </option>
                ))}
              </select>
            </Field>
          </>
        ) : null}

        {node.type === 'question-classifier' ? (
          <>
            <Field label={t('workflowExtractSource')} hint={t('workflowClassifySourceHint')}>
              <input
                className={INPUT_CLASS}
                value={node.config.source}
                placeholder="{{text}}"
                onChange={(event) => onChange({ ...node, config: { ...node.config, source: event.target.value } })}
              />
            </Field>
            <Field label={t('workflowExtractInstruction')}>
              <textarea
                className={`${INPUT_CLASS} min-h-[60px] resize-y`}
                value={node.config.instruction}
                placeholder={t('workflowClassifyInstructionPlaceholder')}
                onChange={(event) =>
                  onChange({ ...node, config: { ...node.config, instruction: event.target.value } })
                }
              />
            </Field>
            <div className="flex flex-col gap-2 border-t border-ds-border pt-3">
              <div className="flex items-center justify-between">
                <span className="text-[12px] font-medium text-ds-muted">{t('workflowClassifyCategories')}</span>
                <button
                  type="button"
                  onClick={() =>
                    onChange({
                      ...node,
                      config: {
                        ...node.config,
                        categories: [
                          ...node.config.categories,
                          { id: `cat-${node.config.categories.length + 1}-${Date.now().toString(36)}`, label: '' }
                        ]
                      }
                    })
                  }
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11.5px] font-medium text-accent transition hover:bg-accent/10"
                >
                  <Plus className="h-3 w-3" strokeWidth={2} />
                  {t('workflowClassifyAddCategory')}
                </button>
              </div>
              {node.config.categories.map((category, index) => (
                <div key={category.id} className="flex items-center gap-2">
                  <span className="w-5 shrink-0 text-center text-[11px] text-ds-faint">{index + 1}</span>
                  <input
                    className={INPUT_CLASS}
                    value={category.label}
                    placeholder={t('workflowClassifyCategoryLabel')}
                    onChange={(event) =>
                      onChange({
                        ...node,
                        config: {
                          ...node.config,
                          categories: node.config.categories.map((item, i) =>
                            i === index ? { ...item, label: event.target.value } : item
                          )
                        }
                      })
                    }
                  />
                  <button
                    type="button"
                    disabled={node.config.categories.length <= 1}
                    onClick={() =>
                      onChange({
                        ...node,
                        config: {
                          ...node.config,
                          categories: node.config.categories.filter((_, i) => i !== index)
                        }
                      })
                    }
                    className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ds-faint transition hover:bg-red-500/10 hover:text-red-600 disabled:opacity-40"
                    aria-label={t('workflowClassifyRemoveCategory')}
                  >
                    <X className="h-3.5 w-3.5" strokeWidth={2} />
                  </button>
                </div>
              ))}
            </div>
            <ModelPicker
              providers={providers}
              providerId={node.config.providerId}
              model={node.config.model}
              onChange={({ providerId, model }) => onChange({ ...node, config: { ...node.config, providerId, model } })}
            />
          </>
        ) : null}

        {node.type === 'custom' ? <CustomNodeForm node={node} settings={settings} onChange={onChange} /> : null}

        <label className="mt-2 flex items-center gap-2 text-[13px] text-ds-muted">
          <input
            type="checkbox"
            checked={node.disabled}
            onChange={(event) => onChange({ ...node, disabled: event.target.checked })}
          />
          {t('workflowNodeDisabled')}
        </label>

        {onSavePreset ? (
          <div className="flex flex-col gap-1.5 border-t border-ds-border pt-3">
            <span className="text-[12px] font-medium text-ds-muted">{t('workflowSaveAsPreset')}</span>
            <div className="flex items-center gap-2">
              <input
                className={INPUT_CLASS}
                value={presetLabel}
                placeholder={node.name.trim() || t(`workflowNode_${node.type}`)}
                onChange={(event) => setPresetLabel(event.target.value)}
              />
              <button
                type="button"
                onClick={() => {
                  onSavePreset(node, presetLabel)
                  setPresetLabel('')
                  setPresetSaved(true)
                  window.setTimeout(() => setPresetSaved(false), 1500)
                }}
                className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-ds-border px-3 text-[12.5px] font-medium text-ds-ink transition hover:bg-ds-hover"
              >
                <Star className="h-3.5 w-3.5" strokeWidth={1.8} />
                {t('workflowSaveAsPresetButton')}
              </button>
            </div>
            {presetSaved ? (
              <span className="text-[11.5px] text-emerald-600">{t('workflowPresetSaved')}</span>
            ) : (
              <span className="text-[11px] leading-4 text-ds-faint">{t('workflowSaveAsPresetHint')}</span>
            )}
          </div>
        ) : null}

        {lastResult && (lastResult.message || lastResult.error || lastResult.outputJson) ? (
          <div className="flex flex-col gap-1.5 border-t border-ds-border pt-3">
            <span className="text-[12px] font-medium text-ds-muted">{t('workflowLastOutput')}</span>
            <pre className="max-h-44 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-ds-subtle px-3 py-2 text-[11.5px] leading-5 text-ds-muted">
              {lastResult.error || lastResult.message || lastResult.outputJson}
            </pre>
          </div>
        ) : null}
      </div>
    </div>
  )
}
