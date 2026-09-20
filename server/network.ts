import type { RequestHandler } from 'express';

/** Accept any destination host, while checking the origin of browser requests. */
export const enforceSameOrigin: RequestHandler = (req, res, next) => {
  const origin = req.get('origin');
  if (origin) {
    try {
      const target = new URL(`${req.protocol}://${req.get('host')}`);
      const source = new URL(origin);
      if (source.origin !== target.origin || source.username || source.password
        || source.pathname !== '/' || source.search || source.hash) throw new Error('Origin mismatch');
    } catch {
      res.status(403).json({ error: 'Cross-origin requests are not allowed.' });
      return;
    }
  }
  if (req.get('sec-fetch-site') === 'cross-site') {
    res.status(403).json({ error: 'Cross-site requests are not allowed.' });
    return;
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
};
