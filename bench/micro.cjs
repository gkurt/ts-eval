// usage: node bench/micro.cjs "<expr using I (varying number literal)>" [imports]
const { execSync } = require('child_process');
const fs = require('fs');
const [expr, imports = ''] = process.argv.slice(2);
const nx = Array.from({ length: 512 }, (_, i) => i + 1).join(', ');
function run(n) {
  fs.writeFileSync('bench/loop.ts', `${imports}
type Nx = [${nx}];
type L<I extends number = 0, Acc = 0> = I extends ${n} ? Acc : L<Nx[I], ${expr} extends infer R ? (R extends never ? Acc : Acc) : never>;
export const p: 'probe' = null! as L;
`);
  const out = execSync('npx tsc -p bench --extendedDiagnostics 2>&1 || true').toString();
  return +out.match(/Instantiations:\s+(\d+)/)[1];
}
const a = run(100), b = run(300);
console.log(`${((b - a) / 200).toFixed(1)} per op: ${expr}`);
