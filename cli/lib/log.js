// Output that reads well for a person and parses well for an agent.
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);

export const log = {
  title: text => console.log(`\n${paint('1', text)}`),
  step: text => console.log(`${paint('36', '›')} ${text}`),
  ok: text => console.log(`${paint('32', '✓')} ${text}`),
  warn: text => console.log(`${paint('33', '!')} ${text}`),
  fail: text => console.log(`${paint('31', '✗')} ${text}`),
  info: text => console.log(`  ${text}`),
  dim: text => console.log(paint('2', `  ${text}`)),
  /** The single thing to do next, printed last so an agent can act on it. */
  next: command => console.log(`\n${paint('1', 'Next:')} ${command}`),
};

export const usd = value => `$${Number(value).toFixed(2)}`;
