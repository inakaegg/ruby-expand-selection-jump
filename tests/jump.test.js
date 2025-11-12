const path = require('path');
const Parser = require('web-tree-sitter');
const Module = require('module');

const vscodeMockPath = path.resolve(__dirname, 'vscode-mock.js');
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === 'vscode') {
    return vscodeMockPath;
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};

const { __internals } = require('../out/extension.js');

if (!__internals?.computeBlockTargetOffset) {
  throw new Error('computeBlockTargetOffset is not exposed via __internals.');
}

const { computeBlockTargetOffset } = __internals;

const SAMPLE = `
while outer_condition
  while inner_condition
    do_something
  end # inner_no_do

  while other_condition do # inner_with_do
    do_something_else
  end # inner_with_do
end # outer

until finish_condition
  handle_until
end # until_no_do

until inline_condition do # until_with_do
  handle_inline_until
end # until_with_do

for item in items
  process_item
end # for_no_do

for value in values do # for_with_do
  process_value
end # for_with_do
`;

function offsetOf(text, marker) {
  const index = text.indexOf(marker);
  if (index === -1) {
    throw new Error(`Marker "${marker}" was not found in sample text.`);
  }
  return index;
}

function expectJump(label, root, fromMarker, toMarker) {
  const from = offsetOf(SAMPLE, fromMarker);
  const expected = offsetOf(SAMPLE, toMarker);
  const actual = computeBlockTargetOffset(root, from);
  if (actual !== expected) {
    throw new Error(`${label}: expected jump to ${expected} but got ${actual}`);
  }
}

function expectBidirectional(label, root, startMarker, endMarker) {
  expectJump(`${label} start -> end`, root, startMarker, endMarker);
  expectJump(`${label} end -> start`, root, endMarker, startMarker);
}

(async () => {
  await Parser.Parser.init();
  const language = await Parser.Language.load(
    path.resolve(__dirname, '../tree-sitter/tree-sitter-ruby.wasm')
  );
  const parser = new Parser.Parser();
  parser.setLanguage(language);

  const tree = parser.parse(SAMPLE);
  const root = tree.rootNode;

  expectBidirectional('outer while', root, 'while outer_condition', 'end # outer');
  expectBidirectional('inner while without do', root, 'while inner_condition', 'end # inner_no_do');
  expectBidirectional(
    'inner while with do',
    root,
    'while other_condition do # inner_with_do',
    'end # inner_with_do'
  );
  expectJump('inline do keyword', root, 'do # inner_with_do', 'end # inner_with_do');

  expectBidirectional('until without do', root, 'until finish_condition', 'end # until_no_do');
  expectBidirectional(
    'until with do',
    root,
    'until inline_condition do # until_with_do',
    'end # until_with_do'
  );
  expectJump('until inline do keyword', root, 'do # until_with_do', 'end # until_with_do');

  expectBidirectional('for without do', root, 'for item in items', 'end # for_no_do');
  expectBidirectional(
    'for with do',
    root,
    'for value in values do # for_with_do',
    'end # for_with_do'
  );
  expectJump('for inline do keyword', root, 'do # for_with_do', 'end # for_with_do');

  tree.delete();
  parser.delete?.();

  console.log('jump tests passed.');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
