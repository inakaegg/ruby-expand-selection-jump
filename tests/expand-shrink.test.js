const path = require('path');
const Module = require('module');

const vscodeMockPath = path.resolve(__dirname, 'vscode-mock.js');
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === 'vscode') {
    return vscodeMockPath;
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};

const vscode = require(vscodeMockPath);
const extension = require('../out/extension.js');

const SAMPLE = [
  'total = orders.sum do |order|',
  '  order.items.sum { |item| item.price_with_tax(rate) }',
  'end'
].join('\n');

const EXPECTED_EXPANSIONS = [
  'price_with_tax',
  'item.price_with_tax',
  'item.price_with_tax(rate)',
  '|item| item.price_with_tax(rate)',
  '{ |item| item.price_with_tax(rate) }',
  'order.items.sum { |item| item.price_with_tax(rate) }',
  '|order|\n  order.items.sum { |item| item.price_with_tax(rate) }',
  'do |order|\n  order.items.sum { |item| item.price_with_tax(rate) }\nend',
  'orders.sum do |order|\n  order.items.sum { |item| item.price_with_tax(rate) }\nend',
  'total = orders.sum do |order|\n  order.items.sum { |item| item.price_with_tax(rate) }\nend'
];

function createDocument(text) {
  const lineStarts = [0];
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '\n') {
      lineStarts.push(index + 1);
    }
  }

  return {
    languageId: 'ruby',
    getText: () => text,
    offsetAt(position) {
      return lineStarts[position.line] + position.character;
    },
    positionAt(offset) {
      let line = lineStarts.length - 1;
      while (line > 0 && lineStarts[line] > offset) {
        line--;
      }
      return new vscode.Position(line, offset - lineStarts[line]);
    }
  };
}

function selectedText(document, selection) {
  return SAMPLE.slice(document.offsetAt(selection.start), document.offsetAt(selection.end));
}

function expectEqual(label, actual, expected) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`);
  }
}

(async () => {
  const document = createDocument(SAMPLE);
  const caretOffset = SAMPLE.indexOf('price_with_tax') + 3;
  const caret = document.positionAt(caretOffset);
  const editor = {
    document,
    selections: [new vscode.Selection(caret, caret)],
    revealRange: () => {}
  };
  vscode.window.activeTextEditor = editor;

  const context = {
    subscriptions: [],
    asAbsolutePath(relativePath) {
      return path.resolve(__dirname, '..', relativePath);
    }
  };
  extension.activate(context);

  for (let index = 0; index < EXPECTED_EXPANSIONS.length; index++) {
    await vscode.commands.executeCommand('rubyExpandSelection.expandSelection');
    expectEqual(
      `expand step ${index + 1}`,
      selectedText(document, editor.selections[0]),
      EXPECTED_EXPANSIONS[index]
    );
  }

  const expectedShrinks = [...EXPECTED_EXPANSIONS.slice(0, -1).reverse(), ''];
  for (let index = 0; index < expectedShrinks.length; index++) {
    await vscode.commands.executeCommand('rubyExpandSelection.shrinkSelection');
    expectEqual(
      `shrink step ${index + 1}`,
      selectedText(document, editor.selections[0]),
      expectedShrinks[index]
    );
  }
  expectEqual('restored caret offset', document.offsetAt(editor.selections[0].active), caretOffset);

  extension.deactivate();
  for (const disposable of context.subscriptions) {
    disposable.dispose();
  }

  console.log('expand/shrink tests passed.');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
