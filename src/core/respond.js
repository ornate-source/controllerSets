// One envelope for every endpoint, written here so no endpoint invents a fifth shape.

export const ok = (res, data) => res.status(200).json({ success: true, data });

export const created = (res, data) => res.status(201).json({ success: true, data });

export const okMessage = (res, message) => res.status(200).json({ success: true, message });

export const okPaginated = (res, { data, pagination }) =>
    res.status(200).json({ success: true, data, pagination });

export const failure = (res, status, error, fields) =>
    res.status(status).json(fields ? { success: false, error, fields } : { success: false, error });
