/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { IContext, IKafkaMessage, IPartitionLambda } from "@prague/services-core";
import { AsyncQueue, queue } from "async";

/**
 * A sequenced lambda processes incoming messages one at a time based on a promise returned by the message handler.
 */
export abstract class SequencedLambda implements IPartitionLambda {
    protected tenantId: string;
    protected documentId: string;

    private q: AsyncQueue<IKafkaMessage>;

    constructor(protected context: IContext) {
        this.q = queue((message: IKafkaMessage, callback) => {
            this.handlerCore(message).then(
                () => {
                    callback();
                },
                (error) => {
                    callback(error);
                });
        }, 1);

        this.q.error = (error) => {
            const documentError = {
                documentId: this.documentId,
                error,
                tenantId: this.tenantId,
            };
            context.error(documentError, true);
        };
    }

    public handler(message: IKafkaMessage): void {
        this.q.push(message);
    }

    public close() {
        this.q.kill();
    }

    /**
     * Derived classes override this method to do per message processing. The sequenced lambda will only move on
     * to the next message once the returned promise is resolved.
     */
    protected abstract handlerCore(message: IKafkaMessage): Promise<void>;
}
