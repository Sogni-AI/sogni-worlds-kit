// Public links: where visitors play a world, and the pictures that stand for it.

/** A link people open: HTTPS, with no name or password in it. */
export const isPublicHttps = url => url.protocol === 'https:' && !url.username && !url.password;

/**
 * A page link as the directory it is served from. Static hosts redirect a
 * directory URL to add its slash, so relative links resolve as they do there
 * (a link that names a file, such as index.html, is left as it is).
 */
export function asDirectory(url) {
  const copy = new URL(url);
  if (!copy.pathname.endsWith('/') && !/\.[^/]+$/.test(copy.pathname)) copy.pathname += '/';
  return copy;
}
