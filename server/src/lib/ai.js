// Thin Claude API client (no SDK dependency) plus extraction helpers.
// Enabled when ANTHROPIC_API_KEY is set; every caller has a manual fallback.
// Extraction results are SUGGESTIONS shown to a person for confirmation — never written blindly.

const API = 'https://api.anthropic.com/v1/messages';
export const aiEnabled = () => !!process.env.ANTHROPIC_API_KEY;
const model = () => process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';

export async function callClaude({ system, messages, tools, maxTokens = 1024, toolChoice }) {
  if (!aiEnabled()) throw new Error('AI is not configured (set ANTHROPIC_API_KEY).');
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: model(), max_tokens: maxTokens, system, messages, ...(tools ? { tools } : {}), ...(toolChoice ? { tool_choice: toolChoice } : {}) }),
    signal: AbortSignal.timeout(45000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`AI request failed (${res.status}): ${data?.error?.message || 'unknown error'}`);
  return data;
}

const fileBlock = (buffer, contentType) => (contentType === 'application/pdf'
  ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } }
  : { type: 'image', source: { type: 'base64', media_type: contentType, data: buffer.toString('base64') } });

/** Force a structured answer through a single tool call. */
async function extract({ buffer, contentType, instruction, schema, name }) {
  const out = await callClaude({
    system: 'You extract fields from UAE HR documents. Only report what is printed on the document. Use null when a field is not visible. Dates as YYYY-MM-DD.',
    messages: [{ role: 'user', content: [fileBlock(buffer, contentType), { type: 'text', text: instruction }] }],
    tools: [{ name, description: 'Return the extracted fields', input_schema: schema }],
    toolChoice: { type: 'tool', name },
    maxTokens: 600,
  });
  const tool = out.content?.find((c) => c.type === 'tool_use');
  return tool?.input || null;
}

export const DOC_TYPES = ['passport', 'residence_visa', 'emirates_id', 'labour_card', 'driving_licence', 'health_insurance', 'trade_licence', 'establishment_card'];

export function ocrDocument(buffer, contentType) {
  return extract({
    buffer, contentType, name: 'document_fields',
    instruction: 'Identify the document type and extract its number, holder name, issue date and expiry date.',
    schema: {
      type: 'object',
      properties: {
        docType: { type: ['string', 'null'], enum: [...DOC_TYPES, null] },
        number: { type: ['string', 'null'] }, holderName: { type: ['string', 'null'] },
        issueDate: { type: ['string', 'null'] }, expiryDate: { type: ['string', 'null'] },
        confidence: { type: 'number', description: '0 to 1' },
      },
      required: ['docType', 'expiryDate', 'confidence'],
    },
  });
}

export function ocrReceipt(buffer, contentType) {
  return extract({
    buffer, contentType, name: 'receipt_fields',
    instruction: 'This is a UAE VAT receipt. Extract merchant, receipt date, total amount in AED, VAT amount in AED, and the merchant TRN if printed.',
    schema: {
      type: 'object',
      properties: {
        merchant: { type: ['string', 'null'] }, date: { type: ['string', 'null'] },
        totalAed: { type: ['number', 'null'] }, vatAed: { type: ['number', 'null'] }, trn: { type: ['string', 'null'] },
        confidence: { type: 'number' },
      },
      required: ['merchant', 'totalAed', 'confidence'],
    },
  });
}
