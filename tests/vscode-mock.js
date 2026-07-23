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

  get start() {
    return comparePositions(this.anchor, this.active) <= 0 ? this.anchor : this.active;
  }

  get end() {
    return comparePositions(this.anchor, this.active) <= 0 ? this.active : this.anchor;
  }

  get isEmpty() {
    return comparePositions(this.anchor, this.active) === 0;
  }
}

function comparePositions(left, right) {
  if (left.line !== right.line) {
    return left.line - right.line;
  }
  return left.character - right.character;
}

const registeredCommands = new Map();

module.exports = {
  commands: {
    registerCommand(command, handler) {
      registeredCommands.set(command, handler);
      return {
        dispose() {
          if (registeredCommands.get(command) === handler) {
            registeredCommands.delete(command);
          }
        }
      };
    },
    async executeCommand(command, ...args) {
      const handler = registeredCommands.get(command);
      if (!handler) {
        throw new Error(`Command "${command}" is not registered.`);
      }
      return handler(...args);
    }
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
