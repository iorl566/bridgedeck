/**
 * @param {object} annotation
 * @param {number} stepId
 * @returns {string}
 */
function annotationText(annotation, stepId) {
  return `  ↳ step ${stepId}: ${annotation.op}${annotation.detail ? `: ${annotation.detail}` : ''}`;
}

/**
 * Render one observation state body with step annotations on their lines.
 *
 * @param {{ stateId: string, url: string, title?: string, stepIds: number[], vomText: string, annotations: object[], stepIdByDraftId: Map<number, number> }} input
 * @returns {string}
 */
export function formatTraceStateBody(input) {
  const lines = ['# bb-observation 1', `state: ${JSON.stringify(input.stateId)}`];
  lines.push(`url: ${JSON.stringify(input.url)}`);
  if (input.title) lines.push(`title: ${JSON.stringify(input.title)}`);
  if (input.stepIds.length > 0) lines.push(`steps_here: [${input.stepIds.join(', ')}]`);
  lines.push('---');

  const byLine = new Map();
  for (const annotation of input.annotations) {
    const stepId = input.stepIdByDraftId.get(annotation.draftId);
    if (stepId === undefined) continue;
    const bucket = byLine.get(annotation.line) ?? [];
    bucket.push({ annotation, stepId });
    byLine.set(annotation.line, bucket);
  }

  input.vomText.split('\n').forEach((bodyLine, lineIndex) => {
    let line = bodyLine;
    for (const item of byLine.get(lineIndex) ?? []) line += annotationText(item.annotation, item.stepId);
    lines.push(line);
  });
  return `${lines.join('\n')}\n`;
}
