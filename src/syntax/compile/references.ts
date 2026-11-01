/* SPDX-FileCopyrightText: Kk Shinkai <i@shinkai.moe>
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Event, ReferenceQuestion } from '../types/index.js';
import { InlineFieldClauseSyntax, StringFieldClauseSyntax, TextBlockSyntax } from '../syntax/block.js';
import { ReferenceLabels } from '../syntax/reading.js';
import type { Syntax } from '../syntax/syntax.js';

/** The tokenizer's binding questions, ordered once for this compilation. */
export class ReferenceQuestions {
  readonly questions: Array<ReferenceQuestion>;

  constructor(events: readonly Event[]) {
    const parsers = new Set(events.map(event => event[2].parser));
    this.questions = [...parsers].flatMap(parser => parser.references).sort((a, b) => a.offset - b.offset);
  }

  /** Copy only questions within the field's source interval. */
  labels(start = 0, end = Infinity): ReferenceLabels {
    const labels = new ReferenceLabels();
    let low = 0;
    let high = this.questions.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.questions[middle].offset < start) low = middle + 1;
      else high = middle;
    }
    for (let index = low; index < this.questions.length && this.questions[index].offset < end; index++) {
      const question = this.questions[index];
      labels[question.kind].add(question.label);
    }
    return labels;
  }

  /** File compilation already owns this tree; each field receives its own questions. */
  fields(tree: Syntax): void {
    tree.iterate({ enter: node => {
      if (node instanceof TextBlockSyntax || node instanceof InlineFieldClauseSyntax ||
          node instanceof StringFieldClauseSyntax) {
        node.references.add(this.labels(node.start, node.end));
        return false;
      }
      return true;
    } });
  }
}
