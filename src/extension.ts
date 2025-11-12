import * as path from 'path';
import * as vscode from 'vscode';
import * as Parser from 'web-tree-sitter';

type SyntaxNode = Parser.Node;

interface BlockInfo {
  start: SyntaxNode;
  end: SyntaxNode;
  starts: SyntaxNode[];
  middles: SyntaxNode[];
}

const BLOCK_NODE_TYPES = new Set([
  'module',
  'class',
  'singleton_class',
  'method',
  'singleton_method',
  'if',
  'unless',
  'case',
  'begin',
  'while',
  'until',
  'for',
  'do_block'
]);

const BLOCK_START_TOKENS: Record<string, string[]> = {
  module: ['module'],
  class: ['class'],
  singleton_class: ['class'],
  method: ['def'],
  singleton_method: ['def'],
  if: ['if'],
  unless: ['unless'],
  case: ['case'],
  begin: ['begin'],
  while: ['while'],
  until: ['until'],
  for: ['for'],
  do_block: ['do']
};

const MIDDLE_KEYWORD_TYPES = new Set(['else', 'elsif', 'when', 'rescue', 'ensure']);

let parser: Parser.Parser | null = null;
let initPromise: Promise<void> | null = null;

interface SelectionSnapshot extends ByteRange {
  anchor: number;
  active: number;
}

const selectionHistories = new WeakMap<vscode.TextDocument, Map<number, SelectionSnapshot[]>>();

function getSelectionHistory(document: vscode.TextDocument): Map<number, SelectionSnapshot[]> {
  let history = selectionHistories.get(document);
  if (!history) {
    history = new Map<number, SelectionSnapshot[]>();
    selectionHistories.set(document, history);
  }
  return history;
}

function normalizeHistoryStack(
  history: Map<number, SelectionSnapshot[]>,
  index: number,
  currentSnapshot: SelectionSnapshot
): SelectionSnapshot[] {
  let stack = history.get(index);
  if (!stack || stack.length === 0 || !snapshotEquals(stack[stack.length - 1], currentSnapshot)) {
    stack = [currentSnapshot];
  }
  history.set(index, stack);
  return stack;
}

function trimSelectionHistory(history: Map<number, SelectionSnapshot[]>, activeSelectionCount: number): void {
  for (const key of Array.from(history.keys())) {
    if (key >= activeSelectionCount) {
      history.delete(key);
    }
  }
}

function selectionToSnapshot(document: vscode.TextDocument, selection: vscode.Selection): SelectionSnapshot {
  const anchorOffset = document.offsetAt(selection.anchor);
  const activeOffset = document.offsetAt(selection.active);
  if (anchorOffset <= activeOffset) {
    return { start: anchorOffset, end: activeOffset, anchor: anchorOffset, active: activeOffset };
  }
  return { start: activeOffset, end: anchorOffset, anchor: anchorOffset, active: activeOffset };
}

function selectionFromSnapshot(document: vscode.TextDocument, snapshot: SelectionSnapshot): vscode.Selection {
  const anchorPosition = document.positionAt(snapshot.anchor);
  const activePosition = document.positionAt(snapshot.active);
  return new vscode.Selection(anchorPosition, activePosition);
}

export function activate(context: vscode.ExtensionContext) {
  const jumpDisposable = vscode.commands.registerCommand('rubyExpandSelection.jump', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }

    const document = editor.document;
    if (document.languageId !== 'ruby') {
      vscode.window.showInformationMessage('Ruby Expand Selection & Jump: current file is not Ruby.');
      return;
    }

    const instance = await ensureParser(context);
    if (!instance) {
      return;
    }

    const text = document.getText();
    const tree = instance.parse(text);
    if (!tree) {
      vscode.window.showInformationMessage('Ruby Expand Selection & Jump: parsing failed.');
      return;
    }

    let targetOffset: number | null = null;
    try {
      const cursorOffset = document.offsetAt(editor.selection.active);
      targetOffset = computeTargetOffset(tree.rootNode, cursorOffset, text);
    } finally {
      tree.delete();
    }

    if (targetOffset == null) {
      vscode.window.showInformationMessage('Ruby Expand Selection & Jump: no matching block or bracket found.');
      return;
    }

    const targetPosition = document.positionAt(targetOffset);
    const selection = new vscode.Selection(targetPosition, targetPosition);
    editor.selection = selection;
    editor.revealRange(new vscode.Range(targetPosition, targetPosition));
  });

  const expandDisposable = vscode.commands.registerCommand(
    'rubyExpandSelection.expandSelection',
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }

      if (!isRubyDocument(editor.document)) {
        vscode.window.showInformationMessage('Ruby Expand Selection & Jump: current file is not Ruby.');
        return;
      }

      const tree = await parseDocument(editor.document, context);
      if (!tree) {
        return;
      }

      let newSelections: vscode.Selection[] = [];
      const history = getSelectionHistory(editor.document);
      try {
        newSelections = editor.selections.map((selection, index) => {
          const previousSnapshot = selectionToSnapshot(editor.document, selection);
          const stack = normalizeHistoryStack(history, index, previousSnapshot);
          const updated = computeSelectionUpdate(editor.document, tree, selection, 'expand');
          const nextSnapshot = selectionToSnapshot(editor.document, updated);
          if (!snapshotEquals(stack[stack.length - 1], nextSnapshot)) {
            stack.push(nextSnapshot);
          }
          return updated;
        });
      } finally {
        tree.delete();
      }

      trimSelectionHistory(history, newSelections.length);

      editor.selections = newSelections;
      if (newSelections.length > 0) {
        editor.revealRange(new vscode.Range(newSelections[0].start, newSelections[0].end));
      }
    }
  );

  const shrinkDisposable = vscode.commands.registerCommand(
    'rubyExpandSelection.shrinkSelection',
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }

      if (!isRubyDocument(editor.document)) {
        vscode.window.showInformationMessage('Ruby Expand Selection & Jump: current file is not Ruby.');
        return;
      }

      const tree = await parseDocument(editor.document, context);
      if (!tree) {
        return;
      }

      let newSelections: vscode.Selection[] = [];
      const history = getSelectionHistory(editor.document);
      try {
        newSelections = editor.selections.map((selection, index) => {
          const currentSnapshot = selectionToSnapshot(editor.document, selection);
          const stack = normalizeHistoryStack(history, index, currentSnapshot);
          if (stack.length > 1) {
            stack.pop();
            const target = stack[stack.length - 1];
            return selectionFromSnapshot(editor.document, target);
          }

          const updated = computeSelectionUpdate(editor.document, tree, selection, 'shrink');
          const nextSnapshot = selectionToSnapshot(editor.document, updated);
          history.set(index, [nextSnapshot]);
          return updated;
        });
      } finally {
        tree.delete();
      }
      trimSelectionHistory(history, newSelections.length);

      editor.selections = newSelections;
      if (newSelections.length > 0) {
        editor.revealRange(new vscode.Range(newSelections[0].start, newSelections[0].end));
      }
    }
  );

  context.subscriptions.push(jumpDisposable, expandDisposable, shrinkDisposable);
}

export function deactivate() {
  parser?.delete();
  parser = null;
  initPromise = null;
}

async function ensureParser(context: vscode.ExtensionContext): Promise<Parser.Parser | null> {
  if (parser) {
    return parser;
  }

  if (!initPromise) {
    initPromise = (async () => {
      await Parser.Parser.init({
        locateFile(scriptName: string) {
          return context.asAbsolutePath(path.join('tree-sitter', scriptName));
        }
      });
      const language = await Parser.Language.load(
        context.asAbsolutePath(path.join('tree-sitter', 'tree-sitter-ruby.wasm'))
      );
      const instance = new Parser.Parser();
      instance.setLanguage(language);
      parser = instance;
    })();
  }

  try {
    await initPromise;
    return parser;
  } catch (error) {
    console.error('Ruby Expand Selection & Jump: failed to initialize Tree-sitter', error);
    vscode.window.showErrorMessage(
      'Ruby Expand Selection & Jump: failed to initialize Tree-sitter. See console for details.'
    );
    parser = null;
    initPromise = null;
    return null;
  }
}

function computeTargetOffset(root: SyntaxNode, cursorOffset: number, text: string): number | null {
  const offsetsToTry = [cursorOffset];
  if (cursorOffset > 0) {
    offsetsToTry.push(cursorOffset - 1);
  }

  for (const offset of offsetsToTry) {
    const blockOffset = computeBlockTargetOffset(root, offset);
    if (blockOffset != null) {
      return blockOffset;
    }
  }

  return computeBracketTargetOffset(text, cursorOffset);
}

function computeBlockTargetOffset(root: SyntaxNode, cursorOffset: number): number | null {
  const nodeAtCursor = root.descendantForIndex(cursorOffset, cursorOffset);
  if (!nodeAtCursor) {
    return null;
  }

  const blockNode = findBlockNode(nodeAtCursor);
  if (!blockNode) {
    return null;
  }

  const info = buildBlockInfo(blockNode);
  if (!info) {
    return null;
  }

  for (const startToken of info.starts) {
    if (offsetTouchesNode(cursorOffset, startToken)) {
      return info.end.startIndex;
    }
  }

  if (offsetTouchesNode(cursorOffset, info.end)) {
    return info.start.startIndex;
  }

  for (const middleToken of info.middles) {
    if (offsetTouchesNode(cursorOffset, middleToken)) {
      return info.end.startIndex;
    }
  }

  return null;
}

function findBlockNode(node: SyntaxNode): SyntaxNode | null {
  let current: SyntaxNode | null = node;
  while (current) {
    if (current.isNamed && BLOCK_NODE_TYPES.has(current.type)) {
      return current;
    }
    current = current.parent;
  }
  return null;
}

function buildBlockInfo(blockNode: SyntaxNode): BlockInfo | null {
  const start = findStartToken(blockNode);
  const end = findEndToken(blockNode);
  if (!start || !end) {
    return null;
  }

  const starts = [start, ...findAdditionalStartTokens(blockNode)];
  const middles: SyntaxNode[] = [];
  collectMiddleTokens(blockNode, middles);

  return { start, end, starts, middles };
}

function findStartToken(blockNode: SyntaxNode): SyntaxNode | null {
  const expected = BLOCK_START_TOKENS[blockNode.type];
  if (!expected || expected.length === 0) {
    return null;
  }

  for (let i = 0; i < blockNode.childCount; i++) {
    const child = blockNode.child(i);
    if (child && expected.includes(child.type)) {
      return child;
    }
  }

  const firstChild = blockNode.child(0);
  if (firstChild && expected.includes(firstChild.type)) {
    return firstChild;
  }

  if (expected.includes(blockNode.type)) {
    return blockNode;
  }

  return null;
}

function findEndToken(node: SyntaxNode): SyntaxNode | null {
  for (let i = node.childCount - 1; i >= 0; i--) {
    const child = node.child(i);
    if (!child) {
      continue;
    }
    if (child.type === 'end') {
      return child;
    }
    if (!BLOCK_NODE_TYPES.has(child.type)) {
      const nested = findEndToken(child);
      if (nested) {
        return nested;
      }
    } else {
      const nested = findEndToken(child);
      if (nested && nested.startIndex >= child.startIndex && nested.endIndex <= child.endIndex) {
        return nested;
      }
    }
  }
  return null;
}

function findAdditionalStartTokens(blockNode: SyntaxNode): SyntaxNode[] {
  const extra: SyntaxNode[] = [];
  if (blockNode.type === 'while' || blockNode.type === 'until' || blockNode.type === 'for') {
    for (let i = 0; i < blockNode.childCount; i++) {
      const child = blockNode.child(i);
      if (child?.type !== 'do') {
        continue;
      }
      const keywordChild = firstChildOfType(child, 'do');
      if (keywordChild) {
        extra.push(keywordChild);
      }
      break;
    }
  }
  return extra;
}

function firstChildOfType(node: SyntaxNode, type: string): SyntaxNode | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.type === type) {
      return child;
    }
  }
  return null;
}

function collectMiddleTokens(node: SyntaxNode, result: SyntaxNode[]): void {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) {
      continue;
    }

    if (MIDDLE_KEYWORD_TYPES.has(child.type)) {
      const keyword = keywordToken(child);
      if (keyword) {
        result.push(keyword);
      }
      collectMiddleTokens(child, result);
      continue;
    }

    if (BLOCK_NODE_TYPES.has(child.type)) {
      continue;
    }

    collectMiddleTokens(child, result);
  }
}

function keywordToken(node: SyntaxNode): SyntaxNode | null {
  if (node.childCount > 0) {
    const first = node.child(0);
    if (first && first.type === node.type) {
      return first;
    }
  }
  return node;
}

function offsetInNode(byteOffset: number, node: SyntaxNode): boolean {
  return byteOffset >= node.startIndex && byteOffset < node.endIndex;
}

function offsetTouchesNode(byteOffset: number, node: SyntaxNode): boolean {
  if (offsetInNode(byteOffset, node)) {
    return true;
  }
  if (byteOffset === node.endIndex && node.endIndex > node.startIndex) {
    return true;
  }
  return false;
}

type BracketDirection = 'forward' | 'backward';

interface BracketInfo {
  index: number;
  char: string;
  match: string;
  direction: BracketDirection;
}

const OPENING_BRACKETS: Record<string, string> = {
  '(': ')',
  '[': ']',
  '{': '}'
};

const CLOSING_BRACKETS: Record<string, string> = {
  ')': '(',
  ']': '[',
  '}': '{'
};

function computeBracketTargetOffset(text: string, cursorOffset: number): number | null {
  const bracketInfo = bracketAtOffset(text, cursorOffset);
  if (!bracketInfo) {
    return null;
  }

  if (bracketInfo.direction === 'forward') {
    return findForwardMatch(text, bracketInfo);
  }

  return findBackwardMatch(text, bracketInfo);
}

function bracketAtOffset(text: string, cursorOffset: number): BracketInfo | null {
  const charAtCursor = cursorOffset < text.length ? text[cursorOffset] : undefined;
  const charBeforeCursor = cursorOffset > 0 ? text[cursorOffset - 1] : undefined;

  if (charAtCursor && OPENING_BRACKETS[charAtCursor]) {
    return {
      index: cursorOffset,
      char: charAtCursor,
      match: OPENING_BRACKETS[charAtCursor],
      direction: 'forward'
    };
  }

  if (charAtCursor && CLOSING_BRACKETS[charAtCursor]) {
    return {
      index: cursorOffset,
      char: charAtCursor,
      match: CLOSING_BRACKETS[charAtCursor],
      direction: 'backward'
    };
  }

  if (charBeforeCursor && OPENING_BRACKETS[charBeforeCursor]) {
    return {
      index: cursorOffset - 1,
      char: charBeforeCursor,
      match: OPENING_BRACKETS[charBeforeCursor],
      direction: 'forward'
    };
  }

  if (charBeforeCursor && CLOSING_BRACKETS[charBeforeCursor]) {
    return {
      index: cursorOffset - 1,
      char: charBeforeCursor,
      match: CLOSING_BRACKETS[charBeforeCursor],
      direction: 'backward'
    };
  }

  return null;
}

function findForwardMatch(text: string, { index, char, match }: BracketInfo): number | null {
  let depth = 1;
  for (let i = index + 1; i < text.length; i++) {
    const current = text[i];
    if (current === char) {
      depth++;
    } else if (current === match) {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return null;
}

function findBackwardMatch(text: string, { index, char, match }: BracketInfo): number | null {
  let depth = 1;
  for (let i = index - 1; i >= 0; i--) {
    const current = text[i];
    if (current === char) {
      depth++;
    } else if (current === match) {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return null;
}

function isRubyDocument(document: vscode.TextDocument): boolean {
  return document.languageId === 'ruby';
}

async function parseDocument(
  document: vscode.TextDocument,
  context: vscode.ExtensionContext
): Promise<Parser.Tree | null> {
  const instance = await ensureParser(context);
  if (!instance) {
    return null;
  }

  const text = document.getText();
  return instance.parse(text);
}

type SelectionDirection = 'expand' | 'shrink';

interface ByteRange {
  start: number;
  end: number;
}

function computeSelectionUpdate(
  document: vscode.TextDocument,
  tree: Parser.Tree,
  selection: vscode.Selection,
  direction: SelectionDirection
): vscode.Selection {
  const root = tree.rootNode;
  const ranges = collectSelectionRanges(document, root, selection);
  const currentRange = selectionToByteRange(document, selection);

  const nextRange =
    direction === 'expand'
      ? findExpandedRange(ranges, currentRange)
      : findShrunkRange(ranges, currentRange, document.offsetAt(selection.active));

  if (!nextRange || (nextRange.start === currentRange.start && nextRange.end === currentRange.end)) {
    return selection;
  }

  const anchorOffset = document.offsetAt(selection.anchor);
  const activeOffset = document.offsetAt(selection.active);
  const startPosition = document.positionAt(nextRange.start);
  const endPosition = document.positionAt(nextRange.end);
  if (anchorOffset <= activeOffset) {
    return new vscode.Selection(startPosition, endPosition);
  }
  return new vscode.Selection(endPosition, startPosition);
}

function selectionToByteRange(document: vscode.TextDocument, selection: vscode.Selection): ByteRange {
  const start = document.offsetAt(selection.start);
  const end = document.offsetAt(selection.end);
  if (start <= end) {
    return { start, end };
  }
  return { start: end, end: start };
}

function collectSelectionRanges(
  document: vscode.TextDocument,
  root: SyntaxNode,
  selection: vscode.Selection
): ByteRange[] {
  const startOffset = document.offsetAt(selection.start);
  const endOffset = document.offsetAt(selection.end);
  const coverageEnd = endOffset > startOffset ? endOffset - 1 : endOffset;

  const node = root.descendantForIndex(startOffset, coverageEnd);
  if (!node) {
    return [];
  }

  const path: SyntaxNode[] = [];
  const seenNodes = new Set<SyntaxNode>();
  const pushPath = (nodeToAdd: SyntaxNode | null) => {
    let current: SyntaxNode | null = nodeToAdd;
    while (current) {
      if (seenNodes.has(current)) {
        current = current.parent;
        continue;
      }
      path.push(current);
      seenNodes.add(current);
      current = current.parent;
    }
  };

  pushPath(node);
  pushPath(root.descendantForIndex(startOffset, startOffset));
  if (selection.isEmpty && startOffset > 0) {
    let candidate = root.descendantForIndex(startOffset - 1, startOffset - 1);
    while (candidate && !candidate.isNamed) {
      candidate = candidate.parent;
    }
    if (candidate && candidate.startIndex < startOffset && candidate.endIndex === startOffset) {
      pushPath(candidate);
    }
  }
  if (endOffset > startOffset) {
    pushPath(root.descendantForIndex(coverageEnd, coverageEnd));
  }

  const rangeMap = new Map<string, ByteRange>();
  const addRange = (start: number, end: number) => {
    if (start < 0 || end < start) {
      return;
    }
    const key = `${start}:${end}`;
    if (!rangeMap.has(key)) {
      rangeMap.set(key, { start, end });
    }
  };

  const addNodeRange = (nodeToAdd: SyntaxNode) => {
    if (nodeToAdd.startIndex === nodeToAdd.endIndex) {
      return;
    }
    if (nodeToAdd.type === 'ERROR') {
      return;
    }
    addRange(nodeToAdd.startIndex, nodeToAdd.endIndex);
  };

  // Include zero-length anchor/active positions so shrink can restore the original caret(s).
  const anchorOffset = document.offsetAt(selection.anchor);
  addRange(anchorOffset, anchorOffset);
  if (!selection.isEmpty) {
    const activeOffset = document.offsetAt(selection.active);
    addRange(activeOffset, activeOffset);
  }

  for (const nodeInPath of path) {
    addNodeRange(nodeInPath);
    addSyntheticRanges(nodeInPath, addRange);
  }

  if (endOffset > startOffset) {
    const stack: SyntaxNode[] = [node];
    const visited = new Set<SyntaxNode>();
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || visited.has(current)) {
        continue;
      }
      visited.add(current);
      for (let i = 0; i < current.childCount; i++) {
        const child = current.child(i);
        if (child) {
          stack.push(child);
        }
      }
      if (current.startIndex < startOffset || current.endIndex > endOffset) {
        continue;
      }
      addNodeRange(current);
      addSyntheticRanges(current, addRange);
    }
  }

  if (!selection.isEmpty) {
    addRange(startOffset, endOffset);
  }

  const ranges = Array.from(rangeMap.values());
  ranges.sort((a, b) => {
    const lengthA = a.end - a.start;
    const lengthB = b.end - b.start;
    if (lengthA !== lengthB) {
      return lengthA - lengthB;
    }
    return a.start - b.start;
  });

  return ranges;
}

type RangeCollector = (start: number, end: number) => void;

function addSyntheticRanges(node: SyntaxNode, collect: RangeCollector): void {
  if (node.type === 'string') {
    const interior = stringInteriorRange(node);
    if (interior) {
      collect(interior.start, interior.end);
    }
    const content = findChildOfType(node, 'string_content');
    if (content) {
      collect(content.startIndex, content.endIndex);
    }
  }

  if (node.type === 'call') {
    const receiver = node.childForFieldName('receiver');
    const method = node.childForFieldName('method');
    const args = node.childForFieldName('arguments');
    if (receiver && method) {
      const accessor = findAccessorToken(node, receiver, method);
      if (accessor) {
        collect(receiver.startIndex, accessor.endIndex);
      }
      collect(receiver.startIndex, method.endIndex);
    }
    if (args) {
      collect(args.startIndex, args.endIndex);
    }
  }

  if (node.type === 'argument_list' || node.type === 'parenthesized_statements') {
    collectDelimitedRanges(node, ['('], [')'], collect);
  }

  if (node.type === 'array') {
    collectDelimitedRanges(node, ['['], [']'], collect);
  }

  if (node.type === 'hash') {
    collectDelimitedRanges(node, ['{'], ['}'], collect);
  }

  if (node.type === 'element_reference') {
    collectDelimitedRanges(node, ['['], [']'], collect);
  }

  if (node.type === 'block' || node.type === 'do_block') {
    const parameters = node.childForFieldName('parameters');
    const body = node.childForFieldName('body');
    if (parameters && body) {
      collect(parameters.startIndex, body.endIndex);
    }
  }
}

function collectDelimitedRanges(
  node: SyntaxNode,
  openings: string[],
  closings: string[],
  collect: RangeCollector
): void {
  const inner = delimitedInnerRange(node, openings, closings);
  if (inner) {
    collect(inner.start, inner.end);
  }

  const outer = delimitedOuterRange(node, openings, closings);
  if (outer) {
    collect(outer.start, outer.end);
  }
}

function findChildOfType(node: SyntaxNode, type: string): SyntaxNode | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.type === type) {
      return child;
    }
  }
  return null;
}

function findAccessorToken(node: SyntaxNode, receiver: SyntaxNode, method: SyntaxNode): SyntaxNode | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child || child.isNamed) {
      continue;
    }
    if (child.startIndex >= receiver.endIndex && child.endIndex <= method.startIndex) {
      return child;
    }
  }
  return null;
}

function stringInteriorRange(node: SyntaxNode): ByteRange | null {
  if (node.childCount === 0) {
    return null;
  }
  const first = node.child(0);
  const last = node.child(node.childCount - 1);
  let start = node.startIndex;
  let end = node.endIndex;
  if (first && !first.isNamed) {
    start = first.endIndex;
  }
  if (last && !last.isNamed) {
    end = last.startIndex;
  }
  if (end <= start) {
    return null;
  }
  return { start, end };
}

function delimitedInnerRange(node: SyntaxNode, openings: string[], closings: string[]): ByteRange | null {
  const open = findDelimiter(node, openings, true);
  const close = findDelimiter(node, closings, false);
  if (!open || !close) {
    return null;
  }
  const start = open.endIndex;
  const end = close.startIndex;
  if (end <= start) {
    return null;
  }
  return { start, end };
}

function delimitedOuterRange(node: SyntaxNode, openings: string[], closings: string[]): ByteRange | null {
  const open = findDelimiter(node, openings, true);
  const close = findDelimiter(node, closings, false);
  if (!open || !close) {
    return null;
  }
  const start = open.startIndex;
  const end = close.endIndex;
  if (end <= start) {
    return null;
  }
  return { start, end };
}

function findDelimiter(node: SyntaxNode, types: string[], fromStart: boolean): SyntaxNode | null {
  if (fromStart) {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child && !child.isNamed && types.includes(child.type)) {
        return child;
      }
    }
    return null;
  }

  for (let i = node.childCount - 1; i >= 0; i--) {
    const child = node.child(i);
    if (child && !child.isNamed && types.includes(child.type)) {
      return child;
    }
  }
  return null;
}

function findExpandedRange(ranges: ByteRange[], current: ByteRange): ByteRange | null {
  const index = indexOfRange(ranges, current);
  if (index !== -1) {
    for (let i = index + 1; i < ranges.length; i++) {
      const candidate = ranges[i];
      if (rangeStrictlyContains(candidate, current)) {
        return candidate;
      }
    }
  }

  let best: ByteRange | null = null;
  for (const candidate of ranges) {
    if (!rangeStrictlyContains(candidate, current)) {
      continue;
    }
    if (!best || rangeSize(candidate) < rangeSize(best)) {
      best = candidate;
    }
  }
  return best;
}

function findShrunkRange(
  ranges: ByteRange[],
  current: ByteRange,
  preferredZeroLengthOffset?: number
): ByteRange | null {
  const index = indexOfRange(ranges, current);
  let zeroLengthCandidate: ByteRange | null = null;
  let preferredZeroLengthCandidate: ByteRange | null = null;

  if (index !== -1) {
    for (let i = index - 1; i >= 0; i--) {
      const candidate = ranges[i];
      if (!rangeStrictlyContains(current, candidate) && !rangeEquals(current, candidate)) {
        continue;
      }
      if (rangeEquals(candidate, current)) {
        continue;
      }
      if (isZeroLengthRange(candidate)) {
        if (preferredZeroLengthOffset != null && candidate.start === preferredZeroLengthOffset) {
          preferredZeroLengthCandidate = candidate;
          continue;
        }
        if (!zeroLengthCandidate) {
          zeroLengthCandidate = candidate;
        }
        continue;
      }
      return candidate;
    }
  }

  let best: ByteRange | null = null;
  for (const candidate of ranges) {
    if (!rangeStrictlyContains(current, candidate) && !rangeEquals(current, candidate)) {
      continue;
    }
    if (rangeEquals(candidate, current)) {
      continue;
    }
    if (isZeroLengthRange(candidate)) {
      if (preferredZeroLengthOffset != null && candidate.start === preferredZeroLengthOffset) {
        preferredZeroLengthCandidate = candidate;
        continue;
      }
      if (!zeroLengthCandidate) {
        zeroLengthCandidate = candidate;
      }
      continue;
    }
    if (
      !best ||
      rangeSize(candidate) > rangeSize(best) ||
      (rangeSize(candidate) === rangeSize(best) && candidate.start > best.start)
    ) {
      best = candidate;
    }
  }
  if (best) {
    return best;
  }
  if (preferredZeroLengthCandidate) {
    return preferredZeroLengthCandidate;
  }
  return zeroLengthCandidate;
}

function isZeroLengthRange(range: ByteRange): boolean {
  return range.start === range.end;
}

function indexOfRange(ranges: ByteRange[], target: ByteRange): number {
  return ranges.findIndex((range) => range.start === target.start && range.end === target.end);
}

function rangeStrictlyContains(outer: ByteRange, inner: ByteRange): boolean {
  return outer.start <= inner.start && outer.end >= inner.end && rangeSize(outer) > rangeSize(inner);
}

function rangeEquals(a: ByteRange, b: ByteRange): boolean {
  return a.start === b.start && a.end === b.end;
}

function rangeSize(range: ByteRange): number {
  return range.end - range.start;
}

function snapshotEquals(a: SelectionSnapshot, b: SelectionSnapshot): boolean {
  return a.start === b.start && a.end === b.end && a.anchor === b.anchor && a.active === b.active;
}

export const __internals = {
  computeSelectionUpdate,
  collectSelectionRanges,
  selectionToByteRange,
  findExpandedRange,
  findShrunkRange,
  computeBlockTargetOffset
};
