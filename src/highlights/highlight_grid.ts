import { getWidth, isDouble } from "../utils/text_cells";
import { calculateEditorColFromVimScreenCol, splitGraphemes } from "../utils/text";

export interface ValidCell {
    text: string;
    hlId: number;
}

export interface Highlight extends ValidCell {
    virtText?: string;
}

export type HighlightRange = NormalTextHighlightRange | VirtualTextHighlightRange;

export interface NormalTextHighlightRange {
    textType: "normal";
    hlId: number;
    line: number;
    startCol: number;
    endCol: number;
}

export interface VirtualTextHighlightRange {
    textType: "virtual";
    highlights: Highlight[];
    line: number;
    col: number;
}

export interface HighlightCellsEvent {
    row: number;
    vimCol: number;
    validCells: ValidCell[];
    lineText: string;
    tabSize: number;
}

export class HighlightGrid {
    /**
     * a three-dimensional array representing rows and columns.
     * Each column can contain multiple highlights. e.g. double-width character, tab
     */
    private grid: Highlight[][][];

    constructor() {
        this.grid = [];
    }

    cleanRow(row: number) {
        delete this.grid[row];
    }

    processHighlightCellsEvent({ row, vimCol, validCells, lineText, tabSize }: HighlightCellsEvent): boolean {
        let hasUpdates = false;

        if (!this.grid[row]) {
            this.grid[row] = [];
        }

        const gridRow = this.grid[row];
        const lineChars = splitGraphemes(lineText);

        // Calculates the number of spaces occupied by the tab
        const calcTabCells = (tabCol: number) => {
            let nearestTabIdx = lineChars.slice(0, tabCol).lastIndexOf("\t");
            nearestTabIdx = nearestTabIdx === -1 ? 0 : nearestTabIdx + 1;
            const center = lineChars.slice(nearestTabIdx, tabCol).join("");
            return tabSize - (getWidth(center, tabSize) % tabSize);
        };

        const editorCol = calculateEditorColFromVimScreenCol(lineText, vimCol, tabSize);
        const cellIter = new CellIter(validCells);

        // #region
        // If the previous column can contain multiple cells,
        // then the redraw cells may contain cells from the previous column.
        if (editorCol > 0) {
            const prevCol = editorCol - 1;
            const prevChar: string | undefined = lineChars[prevCol];
            const expectedCells = prevChar === "\t" ? calcTabCells(prevCol) : getWidth(prevChar ?? "", tabSize);
            if (expectedCells > 1) {
                const expectedVimCol = getWidth(lineChars.slice(0, editorCol).join(""), tabSize);
                if (expectedVimCol > vimCol) {
                    const rightHls: Highlight[] = [];
                    for (let i = 0; i < expectedVimCol - vimCol; i++) {
                        const cell = cellIter.next();
                        cell && rightHls.push({ ...cell, virtText: cell.text });
                    }
                    const leftHls: Highlight[] = [];
                    if (expectedCells - rightHls.length) {
                        leftHls.push(...(gridRow[prevCol] ?? []).slice(0, expectedCells - rightHls.length));
                    }
                    gridRow[prevCol] = [...leftHls, ...rightHls];
                }
            }
        }
        // #endregion

        // Insert additional columns for characters with length greater than 1.
        const filledLineText = splitGraphemes(lineText).reduce((p, c) => p + c + " ".repeat(c.length - 1), "");

        const filledLineChars = splitGraphemes(filledLineText);
        let currCharCol = editorCol;
        let cell = cellIter.next();
        while (cell) {
            const hls: Highlight[] = [];
            const add = (cell: ValidCell, virtText?: string) => hls.push({ ...cell, virtText });
            const currChar = filledLineChars[currCharCol];
            const extraCols = currChar ? currChar.length - 1 : 0;
            currCharCol += extraCols;
            // ... some emojis have text versions e.g. [..."❤️"] == ['❤', '️']
            const hlCol = currCharCol - (currChar ? [...currChar].length - 1 : 0);

            do {
                if (currChar === "\t") {
                    add(cell, cell.text);
                    for (let i = 0; i < calcTabCells(currCharCol) - 1; i++) {
                        cell = cellIter.next();
                        cell && add(cell, cell.text);
                    }

                    break;
                }

                if (currChar && isDouble(currChar)) {
                    if (currChar === cell.text) {
                        add(cell);
                        break;
                    }

                    add(cell, cell.text);
                    if (!isDouble(cell.text)) {
                        const nextCell = cellIter.next();
                        nextCell && add(nextCell, nextCell.text);
                        extraCols && add(nextCell ?? cell, " ".repeat(extraCols));
                    }

                    break;
                }

                if (currChar === cell.text) {
                    add(cell);
                } else {
                    add(cell, cell.text);
                    if (isDouble(cell.text)) {
                        currCharCol++;
                    }
                }

                // eslint-disable-next-line no-constant-condition
            } while (false);

            if (!hls.length || !hls.some((d) => d.hlId !== 0)) {
                if (gridRow[hlCol]) {
                    hasUpdates = true;
                    delete gridRow[hlCol];
                }
            } else {
                hasUpdates = true;
                gridRow[hlCol] = hls;
            }
            /////////////////////////////////////////////
            currCharCol++;
            cell = cellIter.next();
        }

        return hasUpdates;
    }

    buildHighlightRanges(topLine: number): HighlightRange[] {
        const res: HighlightRange[] = [];
        this.grid.forEach((rowHighlights, row) => {
            const line = row + topLine;
            let currHighlight: Highlight | null = null;
            let currStartCol = 0;
            let currEndCol = 0;
            rowHighlights.forEach((colHighlights, col) => {
                if (colHighlights.length > 1 || colHighlights[0].virtText) {
                    res.push({
                        textType: "virtual",
                        highlights: colHighlights,
                        line,
                        col,
                    });
                } else {
                    // Extend range highlights
                    const highlight = colHighlights[0];
                    if (currHighlight?.hlId === highlight.hlId && currEndCol === col - 1) {
                        currEndCol = col;
                    } else {
                        if (currHighlight) {
                            res.push({
                                textType: "normal",
                                hlId: currHighlight.hlId,
                                line,
                                startCol: currStartCol,
                                endCol: currEndCol + 1,
                            });
                        }

                        currHighlight = highlight;
                        currStartCol = col;
                        currEndCol = col;
                    }
                }
            });
            if (currHighlight) {
                res.push({
                    textType: "normal",
                    // @ts-expect-error Typescript is wrong here. It asserts that currHighlight can never be non-null,
                    //                  which is flagrantly incorrect. This is an artifact of the use of forEach.
                    hlId: currHighlight.hlId,
                    line,
                    startCol: currStartCol,
                    endCol: currEndCol + 1,
                });
            }
        });

        return res;
    }

    shiftHighlights(by: number, from: number): void {
        if (by > 0) {
            // remove clipped out rows
            for (let i = 0; i < by; i++) {
                delete this.grid[from + i];
            }
            // first get non empty indexes, then process, seems faster than iterating whole array
            const idxs: number[] = [];
            this.grid.forEach((_row, idx) => {
                idxs.push(idx);
            });
            // shift
            for (const idx of idxs) {
                if (idx <= from) {
                    continue;
                }
                this.grid[idx - by] = this.grid[idx];
                delete this.grid[idx];
            }
        } else if (by < 0) {
            // remove clipped out rows
            for (let i = 0; i < Math.abs(by); i++) {
                delete this.grid[from !== 0 ? from + i : this.grid.length - 1 - i];
            }
            const idxs: number[] = [];
            this.grid.forEach((_row, idx) => {
                idxs.push(idx);
            });
            for (const idx of idxs.reverse()) {
                if (idx <= from) {
                    continue;
                }
                this.grid[idx + Math.abs(by)] = this.grid[idx];
                delete this.grid[idx];
            }
        }
    }

    maxColInRow(row: number) {
        const gridRow = this.grid[row];
        if (!gridRow) {
            return 0;
        }

        let currMaxCol = 0;
        gridRow.forEach((_, col) => {
            if (col > currMaxCol) currMaxCol = col;
        });

        return currMaxCol;
    }
}

class CellIter {
    private _index = 0;
    constructor(private _cells: ValidCell[]) {}
    next(): { text: string; hlId: number } | undefined {
        return this._cells[this._index++];
    }
    getNext(): { text: string; hlId: number } | undefined {
        return this._cells[this._index];
    }
    setNext(hlId: number, text: string) {
        if (this._index < this._cells.length) {
            this._cells[this._index] = { hlId, text };
        }
    }
}
