import { CancellationToken, commands, Disposable, DocumentFilter, Hover,
    HoverProvider, languages, Position, Range, Selection, TextDocument,
    TextDocumentChangeEvent, TextEditor, TextEditorDecorationType,
    TextEditorSelectionChangeEvent, window, workspace } from 'vscode';

export interface Translations { [abbrev: string]: string; }

export class LeanInputExplanationHover implements HoverProvider {
    constructor(private translations: Translations) {}

    getAbbrevations(symbol: string): string[] {
        const abbrevs: string[] = [];
        for (const k in this.translations) {
            if (this.translations[k] === symbol) { abbrevs.push(k); }
        }
        return abbrevs;
    }

    provideHover(document: TextDocument, pos: Position, token: CancellationToken): Hover | undefined {
        const symbolRange = new Range(pos, pos.translate(0, 1));
        const symbol = document.getText(symbolRange);
        const abbrevs = this.getAbbrevations(symbol).sort((a, b) => a.length - b.length);
        return abbrevs.length > 0 &&
            new Hover(`Type ${symbol} using ${abbrevs.map((a) => `\\\\${a}`).join(' or ')}`, symbolRange);
    }
}

class TextEditorAbbrevHandler {
    range: Range;

    constructor(public editor: TextEditor, private abbreviator: LeanInputAbbreviator) {}

    private updateRange(range?: Range) {
        if (range && !range.isSingleLine) { range = null; }
        this.range = range;
        this.editor.setDecorations(this.abbreviator.decorationType, range ? [range] : []);
        this.abbreviator.updateInputActive();

        // HACK: support \{{}} and \[[]]
        const hackyReplacements: {[input: string]: string} = {
            '\\{{}}': '⦃⦄',
            '\\[[]]': '⟦⟧',
        };
        if (range) {
            const replacement = hackyReplacements[this.editor.document.getText(range)];
            if (replacement) {
                this.editor.edit(async (builder) => {
                    await builder.replace(range, replacement);
                    const pos = range.start.translate(0, 1);
                    this.editor.selection = new Selection(pos, pos);
                    this.updateRange();
                });
            }
        }
    }

    get rangeSize(): number {
        return this.range.end.character - this.range.start.character;
    }

    convertRange(newRange?: Range) {
        if (!this.range || this.rangeSize < 2) { return this.updateRange(); }

        const range = this.range;

        const toReplace = this.editor.document.getText(range);
        if (toReplace[0] !== '\\') { return this.updateRange(); }

        const abbreviation = toReplace.slice(1);
        const replacement = this.abbreviator.findReplacement(abbreviation);

        if (replacement) {
            setTimeout(async () => {
                // Without the timeout hack, inserting `\delta ` at the beginning of an
                // existing line would leave the cursor four characters too far right.
                await this.editor.edit((builder) => builder.replace(range, replacement));
                if (newRange) {
                    this.updateRange(new Range(
                        newRange.start.translate(0, replacement.length - toReplace.length),
                        newRange.end.translate(0, replacement.length - toReplace.length)));
                }
            }, 0);
        }

        this.updateRange(newRange);
    }

    onChanged(ev: TextDocumentChangeEvent) {
        if (ev.contentChanges.length === 0) {
            // This event is triggered by files.autoSave=onDelay
            return;
        }
        if (ev.contentChanges.length !== 1) { return this.updateRange(); } // single change
        const change = ev.contentChanges[0];

        if (change.text.length === 1) {
            // insert (or right paren overwriting)
            if (!this.range) {
                if (change.text === '\\') {
                    return this.updateRange(new Range(change.range.start, change.range.start.translate(0, 1)));
                }
            } else if (change.range.start.isEqual(this.range.end)) {
                if (change.text === '\\' && this.rangeSize === 1) { // \\
                    this.range = new Range(this.range.start, change.range.start.translate(0, 1));
                    return this.convertRange();
                } else if (change.text.match(/^\s+|[)}⟩\\]$/)) {
                    // whitespace, closing parens, backslash
                    return this.convertRange(change.text !== '\\' ? null :
                        new Range(change.range.start, change.range.start.translate(0, 1)));
                }
            }
        }

        if (this.range && this.range.contains(change.range) && this.range.start.isBefore(change.range.start)) {
            // modification
            return this.updateRange(new Range(this.range.start,
                this.range.end.translate(0, change.text.length - change.rangeLength)));
        }

        this.updateRange();
    }

    onSelectionChanged(ev: TextEditorSelectionChangeEvent) {
        if (ev.selections.length !== 1 || !this.range.contains(ev.selections[0].active)) {
            this.convertRange();
        }
    }
}

export class LeanInputAbbreviator {
    private subscriptions: Disposable[] = [];

    private handlers = new Map<TextEditor, TextEditorAbbrevHandler>();

    decorationType: TextEditorDecorationType;

    constructor(private translations: Translations, public documentFilter: DocumentFilter) {
        this.translations = Object.assign({}, translations);
        this.translations['\\'] = '\\';

        this.decorationType = window.createTextEditorDecorationType({
            textDecoration: 'underline',
        });

        this.subscriptions.push(workspace.onDidChangeTextDocument((ev) => this.onChanged(ev)));
        this.subscriptions.push(window.onDidChangeTextEditorSelection((ev) => this.onSelectionChanged(ev)));

        this.subscriptions.push(window.onDidChangeVisibleTextEditors((editors) => {
            // delete removed editors
            const handlers = new Map<TextEditor, TextEditorAbbrevHandler>();
            this.handlers.forEach((h, e) => {
                if (editors.indexOf(e) !== -1) {
                    handlers.set(e, h);
                }
            });
            this.handlers = handlers;
        }));

        this.subscriptions.push(window.onDidChangeActiveTextEditor(() => this.updateInputActive()));

        this.subscriptions.push(commands.registerTextEditorCommand('lean.input.convert', (editor, edit) => {
            const handler = this.handlers.get(editor);
            if (handler) {
                handler.convertRange();
            }
        }));
    }

    private setInputActive(isActive: boolean) {
        commands.executeCommand('setContext', 'lean.input.isActive', isActive);
    }

    get active(): boolean {
        const handler = this.handlers.get(window.activeTextEditor);
        return handler && !!handler.range;
    }

    updateInputActive() {
        this.setInputActive(this.active);
    }

    findReplacement(typedAbbrev: string): string | undefined {
        if (this.translations[typedAbbrev]) { return this.translations[typedAbbrev]; }

        let shortestExtension: string = null;
        for (const abbrev in this.translations) {
            if (abbrev.startsWith(typedAbbrev) && (!shortestExtension || abbrev.length < shortestExtension.length)) {
                shortestExtension = abbrev;
            }
        }

        if (shortestExtension) {
            return this.translations[shortestExtension];
        } else if (typedAbbrev) {
            const prefixReplacement = this.findReplacement(
                typedAbbrev.slice(0, typedAbbrev.length - 1));
            if (prefixReplacement) {
                return prefixReplacement + typedAbbrev.slice(typedAbbrev.length - 1);
            }
        }
        return null;
    }

    private onChanged(ev: TextDocumentChangeEvent) {
        const editor = window.activeTextEditor;

        if (editor.document !== ev.document) { return; } // change happened in active editor

        if (!languages.match(this.documentFilter, ev.document)) { return; } // Lean file

        if (!this.handlers.has(editor)) {
            this.handlers.set(editor, new TextEditorAbbrevHandler(editor, this));
        }
        this.handlers.get(editor).onChanged(ev);
    }

    private onSelectionChanged(ev: TextEditorSelectionChangeEvent) {
        const editor = window.activeTextEditor;

        if (editor !== ev.textEditor) { return; } // change happened in active editor

        if (!languages.match(this.documentFilter, editor.document)) { return; } // Lean file

        if (this.handlers.has(editor)) {
            this.handlers.get(editor).onSelectionChanged(ev);
        }
    }

    dispose() {
        this.decorationType.dispose();
        for (const s of this.subscriptions) {
            s.dispose();
        }
    }
}
