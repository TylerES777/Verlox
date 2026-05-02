export function tildify(absPath: string, home: string): string {
  const p = absPath.replace(/\\/g, '/');
  const h = home.replace(/\\/g, '/');
  const isWindows = /^[A-Za-z]:/.test(home);
  const cmpP = isWindows ? p.toLowerCase() : p;
  const cmpH = isWindows ? h.toLowerCase() : h;
  if (cmpP === cmpH) return '~';
  if (cmpP.startsWith(cmpH + '/')) return '~' + p.slice(h.length);
  return p;
}
