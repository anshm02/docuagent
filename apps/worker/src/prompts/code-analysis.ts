export function componentAnalysisPrompt(componentSource: string): string {
  return `Analyze this React component for documentation purposes.
Extract as JSON:
{
  "fields": [{ "label": "", "name": "", "type": "", "required": false, "validation": "", "options": [], "defaultValue": "", "placeholder": "" }],
  "apiCalls": [{ "method": "", "endpoint": "", "purpose": "" }],
  "permissions": [{ "action": "", "role": "" }],
  "modals": [{ "trigger": "", "component": "", "fields": [] }],
  "tableColumns": [{ "header": "", "dataKey": "" }],
  "actions": [{ "label": "", "handler_description": "" }]
}

Only include what you can find in the code. Do not invent fields.
Empty arrays for sections with no data found.

COMPONENT SOURCE:
${componentSource}

Return ONLY valid JSON. No markdown, no explanation, no backticks.`;
}

export function routerExtractionPrompt(routerConfigSource: string): string {
  return `Analyze this React Router configuration and extract all routes.
Return as JSON array:
[
  {
    "path": "/example",
    "component": "ExamplePage.tsx",
    "type": "list|detail|create|settings|dashboard|other"
  }
]

ROUTER CONFIG:
${routerConfigSource}

Return ONLY valid JSON. No markdown, no explanation, no backticks.`;
}
