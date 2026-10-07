// Lint: report tuple types that TypeScript will create as *deferred* type
// references (see README "Lessons"): direct generic alias bodies, or tuples
// whose elements may resolve to a type alias, without a variadic element.
const ts = require('ts5');
const fs = require('fs');
const path = require('path');

const files = process.argv.length > 2 ? process.argv.slice(2) : fs.readdirSync('src').filter(f => f.endsWith('.ts')).map(f => path.join('src', f));
const program = ts.createProgram(files, { noEmit: true, strict: true });
const checker = program.getTypeChecker();

function isAliasRef(node) {
  if (!ts.isTypeReferenceNode(node)) return false;
  let sym = checker.getSymbolAtLocation(node.typeName);
  if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
  return !!sym && !!(sym.flags & ts.SymbolFlags.TypeAlias);
}
function mayResolveTypeAlias(node) {
  switch (node.kind) {
    case ts.SyntaxKind.TypeReference: return isAliasRef(node);
    case ts.SyntaxKind.TypeQuery: return true;
    case ts.SyntaxKind.TypeOperator: return node.operator !== ts.SyntaxKind.UniqueKeyword && mayResolveTypeAlias(node.type);
    case ts.SyntaxKind.ParenthesizedType: case ts.SyntaxKind.OptionalType: case ts.SyntaxKind.NamedTupleMember:
      return mayResolveTypeAlias(node.type);
    case ts.SyntaxKind.RestType:
      return node.type.kind !== ts.SyntaxKind.ArrayType || mayResolveTypeAlias(node.type.elementType);
    case ts.SyntaxKind.UnionType: case ts.SyntaxKind.IntersectionType: return node.types.some(mayResolveTypeAlias);
    case ts.SyntaxKind.IndexedAccessType: return mayResolveTypeAlias(node.objectType) || mayResolveTypeAlias(node.indexType);
    case ts.SyntaxKind.ConditionalType:
      return [node.checkType, node.extendsType, node.trueType, node.falseType].some(mayResolveTypeAlias);
  }
  return false;
}
function isVariadic(el) {
  if (!ts.isRestTypeNode(el)) return false;
  return el.type.kind !== ts.SyntaxKind.ArrayType;  // generic rest => variadic
}
function aliasOf(node) {
  let n = node.parent;
  while (n && (ts.isParenthesizedTypeNode(n))) n = n.parent;
  return n && ts.isTypeAliasDeclaration(n) ? n : undefined;
}
function inExtendsClause(node) {
  for (let n = node; n.parent; n = n.parent) {
    if (ts.isConditionalTypeNode(n.parent) && n.parent.extendsType === n) return true;
    if (ts.isTypeAliasDeclaration(n.parent)) return false;
  }
  return false;
}
function inGenericScope(node) {
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isTypeAliasDeclaration(n)) return !!(n.typeParameters && n.typeParameters.length);
    if (ts.isConditionalTypeNode(n) || ts.isMappedTypeNode(n)) continue;
  }
  return false;
}
// Machine / parser / lexer *states* and modes are rebuilt every step, so a
// deferred one is harmless; only tuples that can outlive a step matter.
const TRANSIENT = new Set(['ret', 'ev', 'ex', 'throw', 'brk', 'cont', 'retfn', 'done', 'err', 'uncaught',
  '!err', '!throw', '!vw', '!done', '!more', '!rev', '%pat',
  'R', 'E', 'U', 'P', 'Post', 'S', 'SL', 'Arg', 'Prop', 'Params', 'Decl', 'Cases', 'CaseBody', 'Pat', 'PArrEl', 'PObjProp']);
function isPersistent(node) {
  const first = node.elements[0];
  if (!first || !ts.isLiteralTypeNode(first) || !ts.isStringLiteral(first.literal)) {
    // untagged tuples: transient unless they sit inside a persistent node
    for (let n = node.parent; n; n = n.parent) {
      if (ts.isTupleTypeNode(n)) return isPersistent(n);
      if (ts.isTypeAliasDeclaration(n) || ts.isConditionalTypeNode(n)) return false;
    }
    return false;
  }
  return !TRANSIENT.has(first.literal.text);
}
let count = 0;
for (const sf of program.getSourceFiles()) {
  if (!files.some(f => path.resolve(f) === path.resolve(sf.fileName))) continue;
  const visit = (node) => {
    if (ts.isTupleTypeNode(node) && inGenericScope(node) && !inExtendsClause(node) && !node.elements.some(isVariadic)) {
      const alias = aliasOf(node);
      const direct = alias && alias.typeParameters && alias.typeParameters.length;
      const bad = node.elements.filter(mayResolveTypeAlias);
      if ((direct || bad.length) && isPersistent(node)) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
        const why = direct ? 'alias body' : 'element: ' + bad.map(b => b.getText().slice(0, 40)).join(' | ');
        console.log(`${path.relative(process.cwd(), sf.fileName)}:${line + 1}  ${node.getText().slice(0, 70).replace(/\s+/g, ' ')}   [${why}]`);
        count++;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}
console.log(`${count} persistent deferred tuple(s)`);
process.exitCode = count ? 1 : 0;
