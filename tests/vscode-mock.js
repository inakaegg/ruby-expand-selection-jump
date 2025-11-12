class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
}

class Range {
  constructor(start, end) {
    this.start = start;
    this.end = end;
  }
}

class Selection {
  constructor(anchor, active) {
    this.anchor = anchor;
    this.active = active;
  }
}

module.exports = {
  commands: {
    registerCommand: () => ({ dispose: () => {} })
  },
  window: {
    activeTextEditor: null,
    showInformationMessage: () => {},
    showErrorMessage: () => {}
  },
  Selection,
  Range,
  Position,
  Uri: {
    file: () => ({})
  },
  workspace: {},
  languages: {}
};
