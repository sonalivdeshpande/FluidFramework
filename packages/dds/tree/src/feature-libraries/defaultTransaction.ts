/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import {
    ChangeFamily,
    Checkout,
    IEditableForest,
    IForestSubscription,
    ProgressiveEditBuilder,
    TransactionResult,
} from "../core";
import { brand } from "../util";

// This is intended to be used by checkout, and not depend on it.
// This allows transaction to be tested in isolation.

/**
 * Keeps a forest in sync with a ProgressiveEditBuilder.
 */
class Transaction<TEditor extends ProgressiveEditBuilder<TChange>, TChange> {
    public readonly editor: TEditor;
    constructor(
        private readonly forest: IEditableForest,
        changeFamily: ChangeFamily<TEditor, TChange>,
    ) {
        this.editor = changeFamily.buildEditor((delta) => {
            this.forest.applyDelta(delta);
        }, forest.anchors);
    }
}

export function runSynchronousTransaction<TEditor extends ProgressiveEditBuilder<TChange>, TChange>(
    checkout: Checkout<TEditor, TChange>,
    command: (forest: IForestSubscription, editor: TEditor) => TransactionResult,
): TransactionResult {
    const t = new Transaction(checkout.forest, checkout.changeFamily);
    const result = command(checkout.forest, t.editor);
    const changes = t.editor.getChanges();
    const edit = checkout.changeFamily.rebaser.compose(changes);

    // TODO: in the non-abort case, optimize this to not rollback the edit,
    // then reapply it (when the local edit is added) when possible.
    {
        // Roll back changes
        const inverse = checkout.changeFamily.rebaser.invert({ revision: brand(-1), change: edit });

        // TODO: maybe unify logic to edit forest and its anchors here with that in ProgressiveEditBuilder.
        // TODO: update schema in addition to anchors and tree data (in both places).
        checkout.changeFamily.rebaser.rebaseAnchors(checkout.forest.anchors, inverse);
        checkout.forest.applyDelta(checkout.changeFamily.intoDelta(inverse));
    }

    if (result === TransactionResult.Apply) {
        checkout.submitEdit(edit);
    }

    return result;
}