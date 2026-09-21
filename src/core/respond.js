/**
 * The response envelope.
 *
 * One shape for every endpoint: `success` is always present to branch on, `data`
 * carries the documents, and a failure carries `error` — never both. Keeping the
 * writers here is what guarantees a new endpoint cannot invent a fifth shape.
 */

export const ok = (res, data) => res.status(200).json({ success: true, data });

export const created = (res, data) => res.status(201).json({ success: true, data });

export const okMessage = (res, message) => res.status(200).json({ success: true, message });

export const okPaginated = (res, { data, pagination }) =>
    res.status(200).json({ success: true, data, pagination });

/**
 * A failure. `fields` appears only when the error carried per-field messages, so
 * clients that do not look for it see exactly the shape they always have.
 */
export const failure = (res, status, error, fields) =>
    res.status(status).json(fields ? { success: false, error, fields } : { success: false, error });
