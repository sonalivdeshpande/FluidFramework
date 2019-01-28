import {
    IChaincodeHost,
    IComponentContext,
    IComponentRuntime,
    IHostRuntime,
} from "@prague/process-definitions";
import {
    ConnectionState,
    IAttachMessage,
    IBlobManager,
    IDeltaManager,
    IDocumentStorageService,
    IEnvelope,
    IPlatform,
    IQuorum,
    ISequencedDocumentMessage,
    ISnapshotTree,
    ITree,
    IUser,
    MessageType,
} from "@prague/runtime-definitions";
import { buildHierarchy, Deferred, flatten } from "@prague/utils";
import * as assert from "assert";
import { EventEmitter } from "events";
import { Component } from "./component";
import { ComponentStorageService } from "./componentStorageService";
import { debug } from "./debug";
import { readAndParse } from "./utils";

// Context will define the component level mappings
export class Context extends EventEmitter implements IComponentContext, IHostRuntime, IPlatform {
    public static async Load(
        tenantId: string,
        id: string,
        platform: IPlatform,
        parentBranch: string,
        existing: boolean,
        options: any,
        clientId: string,
        user: IUser,
        blobManager: IBlobManager,
        chaincode: IChaincodeHost,
        deltaManager: IDeltaManager,
        quorum: IQuorum,
        storage: IDocumentStorageService,
        connectionState: ConnectionState,
        components: Map<string, ISnapshotTree>,
        extraBlobs: Map<string, string>,
        branch: string,
        minimumSequenceNumber: number,
        submitFn: (type: MessageType, contents: any) => void,
        snapshotFn: (message: string) => Promise<void>,
        closeFn: () => void,
    ): Promise<Context> {
        const context = new Context(
            tenantId,
            id,
            parentBranch,
            existing,
            options,
            clientId,
            user,
            blobManager,
            deltaManager,
            quorum,
            platform,
            chaincode,
            storage,
            connectionState,
            branch,
            minimumSequenceNumber,
            submitFn,
            snapshotFn,
            closeFn);

        // Instantiate all components in the document.
        // THOUGHT Does the host want to control some form of this instead? Do we really need to rip through all the
        // components or can we delay load them as necessary?
        const componentsP = new Array<Promise<void>>();
        for (const [componentId, snapshot] of components) {
            const componentP = context.loadComponent(componentId, snapshot, extraBlobs);
            componentsP.push(componentP);
        }

        await Promise.all(componentsP);

        return context;
    }

    public get ready(): Promise<void> {
        this.verifyNotClosed();

        // TODOTODO this needs to defer to the runtime
        return Promise.resolve();
    }

    public get connectionState(): ConnectionState {
        return this._connectionState;
    }

    // Components tracked by the Domain
    private components = new Map<string, Component>();
    private processDeferred = new Map<string, Deferred<Component>>();
    private closed = false;
    private pendingAttach = new Map<string, IAttachMessage>();

    public get connected(): boolean {
        return this.connectionState === ConnectionState.Connected;
    }

    private constructor(
        public readonly tenantId: string,
        public readonly id: string,
        public readonly parentBranch: string,
        public existing: boolean,
        public readonly options: any,
        public clientId: string,
        public readonly user: IUser,
        public readonly blobManager: IBlobManager,
        public readonly deltaManager: IDeltaManager,
        private quorum: IQuorum,
        public readonly platform: IPlatform,
        public readonly chaincode: IChaincodeHost,
        public readonly storage: IDocumentStorageService,
        // tslint:disable-next-line:variable-name
        private _connectionState: ConnectionState,
        public readonly branch: string,
        public readonly minimumSequenceNumber: number,
        public readonly submitFn: (type: MessageType, contents: any) => void,
        public readonly snapshotFn: (message: string) => Promise<void>,
        public readonly closeFn: () => void,
    ) {
        super();
    }

    public async loadComponent(
        id: string,
        snapshotTree: ISnapshotTree,
        extraBlobs: Map<string, string>,
    ): Promise<void> {
        // Need to rip through snapshot and use that to populate extraBlobs
        const runtimeStorage = new ComponentStorageService(this.storage, extraBlobs);
        const details = await readAndParse<{ pkg: string }>(this.storage, snapshotTree.blobs[".component"]);

        const componentP = Component.LoadFromSnapshot(
            this,
            this.tenantId,
            this.id,
            id,
            this.parentBranch,
            this.existing,
            this.options,
            this.clientId,
            this.user,
            this.blobManager,
            details.pkg,
            this.chaincode,
            this.deltaManager,
            this.quorum,
            runtimeStorage,
            this.connectionState,
            this.platform,
            snapshotTree,
            this.id,
            this.deltaManager.minimumSequenceNumber,
            this.submitFn,
            this.snapshotFn,
            this.closeFn);
        const deferred = new Deferred<Component>();
        deferred.resolve(componentP);
        this.processDeferred.set(id, deferred);

        const component = await componentP;

        this.components.set(id, component);

        await component.start();
    }

    public async queryInterface<T>(id: string): Promise<any> {
        switch (id) {
            case "context":
                return this as IComponentContext;
            default:
                return null;
        }
    }

    public snapshot(): ITree {
        // Pull in the prior version and snapshot tree to store against
        const lastVersion = await this.storageService.getVersions(this.id, 1);
        const tree = lastVersion.length > 0
            ? await this.storageService.getSnapshotTree(lastVersion[0])
            : { blobs: {}, commits: {}, trees: {} };

        // Iterate over each component and ask it to snapshot
        const channelEntries = new Map<string, ITree>();
        this.components.forEach((component, key) => channelEntries.set(key, component.snapshot()));

        // Use base tree to know previous component snapshot and then snapshot each component
        const channelCommitsP = new Array<Promise<{ id: string, commit: ICommit }>>();
        for (const [channelId, channelSnapshot] of componentEntries) {
            const parent = channelId in tree.commits ? [tree.commits[channelId]] : [];
            const channelCommitP = this.storageService
                .write(channelSnapshot, parent, `${channelId} commit @${deltaDetails} ${tagMessage}`, channelId)
                .then((commit) => ({ id: channelId, commit }));
            channelCommitsP.push(channelCommitP);
        }

        // Add in module references to the component snapshots
        const channelCommits = await Promise.all(channelCommitsP);
        let gitModules = "";
        for (const channelCommit of channelCommits) {
            root.entries.push({
                mode: FileMode.Commit,
                path: channelCommit.id,
                type: TreeEntry[TreeEntry.Commit],
                value: channelCommit.commit.sha,
            });

            const repoUrl = "https://github.com/kurtb/praguedocs.git"; // this.storageService.repositoryUrl
            gitModules += `[submodule "${channelCommit.id}"]\n\tpath = ${channelCommit.id}\n\turl = ${repoUrl}\n\n`;
        }

        // Write the module lookup details
        root.entries.push({
            mode: FileMode.File,
            path: ".gitmodules",
            type: TreeEntry[TreeEntry.Blob],
            value: {
                contents: gitModules,
                encoding: "utf-8",
            },
        });

        return channelEntries;
    }

    public stop(): { snapshot: Map<string, ISnapshotTree>, blobs: Map<string, string> } {
        this.verifyNotClosed();
        this.closed = true;
        const snapshot = this.snapshot();

        const blobs = new Map<string, string>();
        const result = new Map<string, ISnapshotTree>();
        for (const [id, value] of snapshot) {
            const flattened = flatten(value.entries, blobs);
            const snapshotTree = buildHierarchy(flattened);
            result.set(id, snapshotTree);
        }

        return { blobs, snapshot: result };
    }

    public changeConnectionState(value: ConnectionState, clientId: string) {
        this.verifyNotClosed();

        if (value === this.connectionState) {
            return;
        }

        this._connectionState = value;
        this.clientId = clientId;

        // Resend all pending attach messages prior to notifying clients
        if (value === ConnectionState.Connected) {
            for (const [, message] of this.pendingAttach) {
                this.submit(MessageType.Attach, message);
            }
        }

        for (const [, component] of this.components) {
            component.changeConnectionState(value, clientId);
        }
    }

    public prepare(message: ISequencedDocumentMessage, local: boolean): Promise<any> {
        const envelope = message.contents as IEnvelope;
        const component = this.components.get(envelope.address);

        if (!component) {
            console.log(JSON.stringify(message, null, 2));
        }

        assert(component);
        const innerContents = envelope.contents as { content: any, type: string };

        const transformed: ISequencedDocumentMessage = {
            clientId: message.clientId,
            clientSequenceNumber: message.clientSequenceNumber,
            contents: innerContents.content,
            metadata: message.metadata,
            minimumSequenceNumber: message.minimumSequenceNumber,
            origin: message.origin,
            referenceSequenceNumber: message.referenceSequenceNumber,
            sequenceNumber: message.sequenceNumber,
            timestamp: message.timestamp,
            traces: message.traces,
            type: innerContents.type,
            user: message.user,
        };

        return component.prepare(transformed, local);
    }

    public process(message: ISequencedDocumentMessage, local: boolean, context: any) {
        const envelope = message.contents as IEnvelope;
        const component = this.components.get(envelope.address);
        assert(component);
        const innerContents = envelope.contents as { content: any, type: string };

        const transformed: ISequencedDocumentMessage = {
            clientId: message.clientId,
            clientSequenceNumber: message.clientSequenceNumber,
            contents: innerContents.content,
            metadata: message.metadata,
            minimumSequenceNumber: message.minimumSequenceNumber,
            origin: message.origin,
            referenceSequenceNumber: message.referenceSequenceNumber,
            sequenceNumber: message.sequenceNumber,
            timestamp: message.timestamp,
            traces: message.traces,
            type: innerContents.type,
            user: message.user,
        };

        component.process(transformed, local, context);
    }

    public postProcess(message: ISequencedDocumentMessage, local: boolean, context: any): Promise<void> {
        return;
    }

    public async prepareAttach(message: ISequencedDocumentMessage, local: boolean): Promise<Component> {
        this.verifyNotClosed();

        // the local object has already been attached
        if (local) {
            return;
        }

        const attachMessage = message.contents as IAttachMessage;
        let snapshotTree: ISnapshotTree = null;
        if (attachMessage.snapshot) {
            const flattened = flatten(attachMessage.snapshot.entries, new Map());
            snapshotTree = buildHierarchy(flattened);
        }

        // create storage service that wraps the attach data
        const runtimeStorage = new ComponentStorageService(this.storage, new Map());
        const component = await Component.LoadFromSnapshot(
            this,
            this.tenantId,
            this.id,
            attachMessage.id,
            this.parentBranch,
            this.existing,
            this.options,
            this.clientId,
            this.user,
            this.blobManager,
            attachMessage.type,
            this.chaincode,
            this.deltaManager,
            this.quorum,
            runtimeStorage,
            this.connectionState,
            this.platform,
            snapshotTree,
            this.id,
            this.deltaManager.minimumSequenceNumber,
            this.submitFn,
            this.snapshotFn,
            this.closeFn);

        return component;
    }

    public processAttach(message: ISequencedDocumentMessage, local: boolean, context: Component): void {
        this.verifyNotClosed();
        debug("processAttach");
    }

    public async postProcessAttach(
        message: ISequencedDocumentMessage,
        local: boolean,
        context: Component,
    ): Promise<void> {
        const attachMessage = message.contents as IAttachMessage;

        // If a non-local operation then go and create the object - otherwise mark it as officially attached.
        if (local) {
            assert(this.pendingAttach.has(attachMessage.id));
            this.pendingAttach.delete(attachMessage.id);
        } else {
            await context.start();

            this.components.set(attachMessage.id, context);

            // Resolve pending gets and store off any new ones
            if (this.processDeferred.has(attachMessage.id)) {
                this.processDeferred.get(attachMessage.id).resolve(context);
            } else {
                const deferred = new Deferred<Component>();
                deferred.resolve(context);
                this.processDeferred.set(attachMessage.id, deferred);
            }
        }
    }

    public updateMinSequenceNumber(minimumSequenceNumber: number) {
        for (const [, component] of this.components) {
            component.updateMinSequenceNumber(minimumSequenceNumber);
        }
    }

    public getProcess(id: string, wait = true): Promise<IComponentRuntime> {
        this.verifyNotClosed();

        if (!this.processDeferred.has(id)) {
            if (!wait) {
                return Promise.reject(`Process ${id} does not exist`);
            }

            // Add in a deferred that will resolve once the process ID arrives
            this.processDeferred.set(id, new Deferred<Component>());
        }

        return this.processDeferred.get(id).promise;
    }

    public async createAndAttachProcess(id: string, pkg: string): Promise<IComponentRuntime> {
        this.verifyNotClosed();

        const runtimeStorage = new ComponentStorageService(this.storage, new Map());
        const component = await Component.create(
            this,
            this.tenantId,
            this.id,
            id,
            this.parentBranch,
            this.existing,
            this.options,
            this.clientId,
            this.user,
            this.blobManager,
            pkg,
            this.chaincode,
            this.deltaManager,
            this.quorum,
            runtimeStorage,
            this.connectionState,
            this.platform,
            this.id,
            this.deltaManager.minimumSequenceNumber,
            this.submitFn,
            this.snapshotFn,
            this.closeFn);

        // Generate the attach message
        const message: IAttachMessage = {
            id,
            snapshot: null,
            type: pkg,
        };
        this.pendingAttach.set(id, message);
        this.submit(MessageType.Attach, message);

        // Start the component
        await component.start();

        // Store off the component
        this.components.set(id, component);

        // Resolve any pending requests for the component
        if (this.processDeferred.has(id)) {
            this.processDeferred.get(id).resolve(component);
        } else {
            const deferred = new Deferred<Component>();
            deferred.resolve(component);
            this.processDeferred.set(id, deferred);
        }

        return component;
    }

    public getQuorum(): IQuorum {
        return this.quorum;
    }

    public error(error: any) {
        // TODO bubble up to parent
        debug("Context has encountered a non-recoverable error");
    }

    private submit(type: MessageType, content: any) {
        this.verifyNotClosed();
        this.submitFn(type, content);
    }

    private verifyNotClosed() {
        if (this.closed) {
            throw new Error("Runtime is closed");
        }
    }
}
