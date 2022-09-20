/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { ITelemetryLogger, ITelemetryProperties } from "@fluidframework/common-definitions";
import { assert, Timer } from "@fluidframework/common-utils";
import { IConnectionDetails, IDeltaManager } from "@fluidframework/container-definitions";
import { ILocalSequencedClient, IProtocolHandler } from "@fluidframework/protocol-base";
import { ConnectionMode, IQuorumClients } from "@fluidframework/protocol-definitions";
import { PerformanceEvent, loggerToMonitoringContext } from "@fluidframework/telemetry-utils";
import { ConnectionState } from "./connectionState";
import { CatchUpMonitor, ICatchUpMonitor } from "./catchUpMonitor";

const JoinOpTimeoutMs = 45000;

/** Constructor parameter type for passing in dependencies needed by the ConnectionStateHandler */
export interface IConnectionStateHandlerInputs {
    logger: ITelemetryLogger;
    /** Provides access to the clients currently in the quorum */
    quorumClients: () => IQuorumClients | undefined;
    /** Log to telemetry any change in state, included to Connecting */
    connectionStateChanged:
        (value: ConnectionState, oldState: ConnectionState, reason?: string | undefined) => void;
    /** Whether to expect the client to join in write mode on next connection */
    shouldClientJoinWrite: () => boolean;
    /** (Optional) How long should we wait on our previous client's Leave op before transitioning to Connected again */
    maxClientLeaveWaitTime: number | undefined;
    /** Log an issue encountered while in the Connecting state. details will be logged as a JSON string */
    logConnectionIssue: (eventName: string, details?: ITelemetryProperties) => void;
}

/**
 * interface that connection state handler implements
 */
export interface IConnectionStateHandler {
    readonly connectionState: ConnectionState;
    readonly pendingClientId: string | undefined;

    containerSaved(): void;
    dispose(): void;
    initProtocol(protocol: IProtocolHandler): void;
    receivedConnectEvent(connectionMode: ConnectionMode, details: IConnectionDetails): void;
    receivedDisconnectEvent(reason: string): void;
}

export function createConnectionStateHandler(
    inputs: IConnectionStateHandlerInputs,
    deltaManager: IDeltaManager<any, any>,
    clientId?: string,
) {
    const mc = loggerToMonitoringContext(inputs.logger);
    return createConnectionStateHandlerCore(
        mc.config.getBoolean("Fluid.Container.CatchUpBeforeDeclaringConnected") === true,
        inputs,
        deltaManager,
        clientId,
    );
}

export function createConnectionStateHandlerCore(
    wait: boolean,
    inputs: IConnectionStateHandlerInputs,
    deltaManager: IDeltaManager<any, any>,
    clientId?: string,
) {
    if (!wait) {
        return new ConnectionStateHandler(inputs, clientId);
    }
    return new ConnectionStateCatchup(
        inputs,
        (handler: IConnectionStateHandlerInputs) => new ConnectionStateHandler(handler, clientId),
        deltaManager);
}

/**
 * Class that can be used as a base class for building IConnectionStateHandler adapters / pipeline.
 * It implements both ends of communication interfaces and passes data back and forward
 */
class ConnectionStateHandlerPassThrough implements IConnectionStateHandler, IConnectionStateHandlerInputs {
    protected readonly pimpl: IConnectionStateHandler;

    constructor(
        protected readonly inputs: IConnectionStateHandlerInputs,
        pimplFactory: (handler: IConnectionStateHandlerInputs) => IConnectionStateHandler,
    ) {
        this.pimpl = pimplFactory(this);
    }

    /**
     * IConnectionStateHandler
     */
    public get connectionState() { return this.pimpl.connectionState; }
    public get pendingClientId() { return this.pimpl.pendingClientId; }

    public containerSaved() { return this.pimpl.containerSaved(); }
    public dispose() { return this.pimpl.dispose(); }
    public initProtocol(protocol: IProtocolHandler) { return this.pimpl.initProtocol(protocol); }
    public receivedDisconnectEvent(reason: string) { return this.pimpl.receivedDisconnectEvent(reason); }

    public receivedConnectEvent(connectionMode: ConnectionMode, details: IConnectionDetails) {
        return this.pimpl.receivedConnectEvent(connectionMode, details);
    }

    /**
     * IConnectionStateHandlerInputs
     */

    public get logger() { return this.inputs.logger; }
    public quorumClients() { return this.inputs.quorumClients(); }
    public connectionStateChanged(
        value: ConnectionState,
        oldState: ConnectionState,
        reason?: string | undefined,
    ) {
        return this.inputs.connectionStateChanged(value, oldState, reason);
    }
    public shouldClientJoinWrite() { return this.inputs.shouldClientJoinWrite(); }
    public get maxClientLeaveWaitTime() { return this.inputs.maxClientLeaveWaitTime; }
    public logConnectionIssue(eventName: string, details?: ITelemetryProperties) {
        return this.inputs.logConnectionIssue(eventName, details);
    }
}

/**
 * Implementation of IConnectionStateHandler pass-through adapter that waits for specific sequence number
 * before raising connected event
 */
class ConnectionStateCatchup extends ConnectionStateHandlerPassThrough {
    private catchUpMonitor: ICatchUpMonitor | undefined;

    constructor(
        inputs: IConnectionStateHandlerInputs,
        pimplFactory: (handler: IConnectionStateHandlerInputs) => IConnectionStateHandler,
        private readonly deltaManager: IDeltaManager<any, any>,
    ) {
        super(inputs, pimplFactory);
        this._connectionState = this.pimpl.connectionState;
    }

    private _connectionState: ConnectionState;
    public get connectionState() {
        return this._connectionState;
    }

    public connectionStateChanged(value: ConnectionState, oldState: ConnectionState, reason?: string | undefined) {
        switch (value) {
            case ConnectionState.Connected:
                assert(this._connectionState === ConnectionState.CatchingUp, "connectivity transitions");
                assert(this.catchUpMonitor !== undefined,
                    "catchUpMonitor should always be set if pendingClientId is set");
                this.catchUpMonitor.on("caughtUp", this.transitionToConnectedState);
                return;
            case ConnectionState.Disconnected:
                this.catchUpMonitor?.dispose();
                this.catchUpMonitor = undefined;
                break;
            case ConnectionState.CatchingUp:
                assert(this._connectionState === ConnectionState.Disconnected, "connectivity transitions");
                // We may want to catch up to known ops as of now before transitioning to Connected state
                assert(this.catchUpMonitor === undefined, "catchUpMonitor should be gone");
                this.catchUpMonitor = new CatchUpMonitor(this.deltaManager);
                break;
            default:
        }
        this._connectionState = value;
        this.inputs.connectionStateChanged(value, oldState, reason);
    }

    private readonly transitionToConnectedState = () => {
        // Defensive measure, we should always be in Connecting state when this is called.
        const state = this.pimpl.connectionState;
        assert(state === ConnectionState.Connected, "invariant broken");
        assert(this._connectionState === ConnectionState.CatchingUp, "invariant broken");
        this._connectionState = ConnectionState.Connected;
        this.inputs.connectionStateChanged(ConnectionState.Connected, ConnectionState.CatchingUp, "caught up");
    };
}

/**
 * In the lifetime of a container, the connection will likely disconnect and reconnect periodically.
 * This class ensures that any ops sent by this container instance on previous connection are either
 * sequenced or blocked by the server before emitting the new "connected" event and allowing runtime to resubmit ops.
 *
 * Each connection is assigned a clientId by the service, and the connection is book-ended by a Join and a Leave op
 * generated by the service. Due to the distributed nature of the Relay Service, in the case of reconnect we cannot
 * make any assumptions about ordering of operations between the old and new connections - i.e. new Join op could
 * be sequenced before old Leave op (and some acks from pending ops that were in flight when we disconnected).
 *
 * The job of this class is to encapsulate the transition period during reconnect, which is identified by
 * ConnectionState.CatchingUp. Specifically, before moving to Connected state with the new clientId, it ensures that:
 *
 * a. We process the Leave op for the previous clientId. This allows us to properly handle any acks from in-flight ops
 * that got sequenced with the old clientId (we'll recognize them as local ops). After the Leave op, any other
 * pending ops can safely be submitted with the new clientId without fear of duplication in the sequenced op stream.
 *
 * b. We process the Join op for the new clientId (identified when the underlying connection was first established),
 * indicating the service is ready to sequence ops sent with the new clientId.
 *
 * c. We process all ops known at the time the underlying connection was established (so we are "caught up")
 *
 * For (a) we give up waiting after some time (same timeout as server uses), and go ahead and transition to Connected.
 *
 * For (b) we log telemetry if it takes too long, but still only transition to Connected when the Join op is processed
 * and we are added to the Quorum.
 *
 * For (c) this is optional behavior, controlled by the parameters of receivedConnectEvent
 */
class ConnectionStateHandler implements IConnectionStateHandler {
    private _connectionState = ConnectionState.Disconnected;
    private _pendingClientId: string | undefined;
    private readonly prevClientLeftTimer: Timer;
    private readonly joinOpTimer: Timer;

    private waitEvent: PerformanceEvent | undefined;

    public get connectionState(): ConnectionState {
        return this._connectionState;
    }

    private get clientId(): string | undefined {
        return this._clientId;
    }

    public get pendingClientId(): string | undefined {
        return this._pendingClientId;
    }

    constructor(
        private readonly handler: IConnectionStateHandlerInputs,
        private _clientId?: string,
    ) {
        this.prevClientLeftTimer = new Timer(
            // Default is 5 min for which we are going to wait for its own "leave" message. This is same as
            // the max time on server after which leave op is sent.
            this.handler.maxClientLeaveWaitTime ?? 300000,
            () => {
                assert(this.connectionState !== ConnectionState.Connected,
                    0x2ac /* "Connected when timeout waiting for leave from previous session fired!" */);
                this.applyForConnectedState("timeout");
            },
        );

        // Based on recent data, it looks like majority of cases where we get stuck are due to really slow or
        // timing out ops fetches. So attempt recovery infrequently. Also fetch uses 30 second timeout, so
        // if retrying fixes the problem, we should not see these events.
        this.joinOpTimer = new Timer(
            JoinOpTimeoutMs,
            () => {
                // I've observed timer firing within couple ms from disconnect event, looks like
                // queued timer callback is not cancelled if timer is cancelled while callback sits in the queue.
                if (this.connectionState !== ConnectionState.CatchingUp) {
                    return;
                }
                const quorumClients = this.handler.quorumClients();
                const details = {
                    quorumInitialized: quorumClients !== undefined,
                    pendingClientId: this.pendingClientId,
                    inQuorum: quorumClients?.getMember(this.pendingClientId ?? "") !== undefined,
                    waitingForLeaveOp: this.waitingForLeaveOp,
                };
                this.handler.logConnectionIssue("NoJoinOp", details);
            },
        );
    }

    private startJoinOpTimer() {
        assert(!this.joinOpTimer.hasTimer, 0x234 /* "has joinOpTimer" */);
        this.joinOpTimer.start();
    }

    private stopJoinOpTimer() {
        assert(this.joinOpTimer.hasTimer, 0x235 /* "no joinOpTimer" */);
        this.joinOpTimer.clear();
    }

    private get waitingForLeaveOp() {
        return this.prevClientLeftTimer.hasTimer;
    }

    public dispose() {
        assert(!this.joinOpTimer.hasTimer, 0x2a5 /* "join timer" */);
        this.prevClientLeftTimer.clear();
    }

    public containerSaved() {
        // If we were waiting for moving to Connected state, then only apply for state change. Since the container
        // is now saved and we don't have any ops to roundtrip, we can clear the timer and apply for connected state.
        if (this.waitingForLeaveOp) {
            this.prevClientLeftTimer.clear();
            this.applyForConnectedState("containerSaved");
        }
    }

    private receivedAddMemberEvent(clientId: string) {
        // This is the only one that requires the pending client ID
        if (clientId === this.pendingClientId) {
            if (this.joinOpTimer.hasTimer) {
                this.stopJoinOpTimer();
            } else {
                // timer has already fired, meaning it took too long to get join on.
                // Record how long it actually took to recover.
                this.handler.logConnectionIssue("ReceivedJoinOp");
            }
            // Start the event in case we are waiting for leave or timeout.
            if (this.waitingForLeaveOp) {
                this.waitEvent = PerformanceEvent.start(this.handler.logger, {
                    eventName: "WaitBeforeClientLeave",
                    details: JSON.stringify({
                        waitOnClientId: this._clientId,
                        hadOutstandingOps: this.handler.shouldClientJoinWrite(),
                    }),
                });
            }
            this.applyForConnectedState("addMemberEvent");
        }
    }

    private applyForConnectedState(source: "removeMemberEvent" | "addMemberEvent" | "timeout" | "containerSaved") {
        const quorumClients = this.handler.quorumClients();
        assert(quorumClients !== undefined, 0x236 /* "In all cases it should be already installed" */);

        assert(this.waitingForLeaveOp === false ||
            (this.clientId !== undefined && quorumClients.getMember(this.clientId) !== undefined),
            0x2e2 /* "Must only wait for leave message when clientId in quorum" */);

        // Move to connected state only if we are in Connecting state, we have seen our join op
        // and there is no timer running which means we are not waiting for previous client to leave
        // or timeout has occurred while doing so.
        if (this.pendingClientId !== this.clientId
            && this.pendingClientId !== undefined
            && quorumClients.getMember(this.pendingClientId) !== undefined
            && !this.waitingForLeaveOp
        ) {
            this.waitEvent?.end({ source });
            this.setConnectionState(ConnectionState.Connected);
        } else {
            // Adding this event temporarily so that we can get help debugging if something goes wrong.
            this.handler.logger.sendTelemetryEvent({
                eventName: "connectedStateRejected",
                category: source === "timeout" ? "error" : "generic",
                details: JSON.stringify({
                    source,
                    pendingClientId: this.pendingClientId,
                    clientId: this.clientId,
                    waitingForLeaveOp: this.waitingForLeaveOp,
                    inQuorum: quorumClients?.getMember(this.pendingClientId ?? "") !== undefined,
                }),
            });
        }
    }

    private receivedRemoveMemberEvent(clientId: string) {
        // If the client which has left was us, then finish the timer.
        if (this.clientId === clientId) {
            this.prevClientLeftTimer.clear();
            this.applyForConnectedState("removeMemberEvent");
        }
    }

    public receivedDisconnectEvent(reason: string) {
        this.setConnectionState(ConnectionState.Disconnected, reason);
    }

    /**
     * The "connect" event indicates the connection to the Relay Service is live.
     * However, some additional conditions must be met before we can fully transition to
     * "Connected" state. This function handles that interim period, known as "Connecting" state.
     * @param connectionMode - Read or Write connection
     * @param details - Connection details returned from the Relay Service
     * @param deltaManager - DeltaManager to be used for delaying Connected transition until caught up.
     * If it's undefined, then don't delay and transition to Connected as soon as Leave/Join op are accounted for
     */
    public receivedConnectEvent(
        connectionMode: ConnectionMode,
        details: IConnectionDetails,
    ) {
        const oldState = this._connectionState;
        this._connectionState = ConnectionState.CatchingUp;

        const writeConnection = connectionMode === "write";
        assert(!this.handler.shouldClientJoinWrite() || writeConnection,
            0x30a /* shouldClientJoinWrite should imply this is a writeConnection */);
        assert(!this.waitingForLeaveOp || writeConnection,
            0x2a6 /* "waitingForLeaveOp should imply writeConnection (we need to be ready to flush pending ops)" */);

        // Note that this may be undefined since the connection is established proactively on load
        // and the quorum may still be under initialization.
        const quorumClients: IQuorumClients | undefined = this.handler.quorumClients();

        // Stash the clientID to detect when transitioning from connecting (socket.io channel open) to connected
        // (have received the join message for the client ID)
        // This is especially important in the reconnect case. It's possible there could be outstanding
        // ops sent by this client, so we should keep the old client id until we see our own client's
        // join message. after we see the join message for our new connection with our new client id,
        // we know there can no longer be outstanding ops that we sent with the previous client id.
        this._pendingClientId = details.clientId;

        // IMPORTANT: Report telemetry after we set _pendingClientId, but before transitioning to Connected state
        this.handler.connectionStateChanged(ConnectionState.CatchingUp, oldState);

        // For write connections, this pending clientId could be in the quorum already (i.e. join op already processed).
        // We are fetching ops from storage in parallel to connecting to Relay Service,
        // and given async processes, it's possible that we have already processed our own join message before
        // connection was fully established.
        // If quorumClients itself is undefined, we expect it will process the join op after it's initialized.
        const waitingForJoinOp = writeConnection && quorumClients?.getMember(this._pendingClientId) === undefined;

        if (waitingForJoinOp) {
            // Previous client left, and we are waiting for our own join op. When it is processed we'll join the quorum
            // and attempt to transition to Connected state via receivedAddMemberEvent.
            this.startJoinOpTimer();
        } else if (!this.waitingForLeaveOp) {
            // We're not waiting for Join or Leave op (if read-only connection those don't even apply),
            // go ahead and declare the state to be Connected!
            // If we are waiting for Leave op still, do nothing for now, we will transition to Connected later.
            this.setConnectionState(ConnectionState.Connected);
        }
        // else - We are waiting for Leave op still, do nothing for now, we will transition to Connected later
    }

    private setConnectionState(value: ConnectionState.Disconnected, reason: string): void;
    private setConnectionState(value: ConnectionState.Connected): void;
    private setConnectionState(value: ConnectionState.Disconnected | ConnectionState.Connected, reason?: string): void {
        if (this.connectionState === value) {
            // Already in the desired state - exit early
            this.handler.logger.sendErrorEvent({ eventName: "setConnectionStateSame", value });
            return;
        }

        const oldState = this._connectionState;
        this._connectionState = value;
        const quorumClients = this.handler.quorumClients();
        let client: ILocalSequencedClient | undefined;
        if (this._clientId !== undefined) {
            client = quorumClients?.getMember(this._clientId);
        }
        if (value === ConnectionState.Connected) {
            assert(oldState === ConnectionState.CatchingUp,
                0x1d8 /* "Should only transition from Connecting state" */);
            // Mark our old client should have left in the quorum if it's still there
            if (client !== undefined) {
                client.shouldHaveLeft = true;
            }
            this._clientId = this.pendingClientId;
        } else if (value === ConnectionState.Disconnected) {
            // Clear pending state immediately to prepare for reconnect
            this._pendingClientId = undefined;

            if (this.joinOpTimer.hasTimer) {
                this.stopJoinOpTimer();
            }

            // Only wait for "leave" message if the connected client exists in the quorum because only the write
            // client will exist in the quorum and only for those clients we will receive "removeMember" event and
            // the client has some unacked ops.
            // Also server would not accept ops from read client. Also check if the timer is not already running as
            // we could receive "Disconnected" event multiple times without getting connected and in that case we
            // don't want to reset the timer as we still want to wait on original client which started this timer.
            if (client !== undefined
                && this.handler.shouldClientJoinWrite()
                && this.prevClientLeftTimer.hasTimer === false
            ) {
                this.prevClientLeftTimer.restart();
            } else {
                // Adding this event temporarily so that we can get help debugging if something goes wrong.
                this.handler.logger.sendTelemetryEvent({
                    eventName: "noWaitOnDisconnected",
                    details: JSON.stringify({
                        inQuorum: client !== undefined,
                        waitingForLeaveOp: this.waitingForLeaveOp,
                        hadOutstandingOps: this.handler.shouldClientJoinWrite(),
                    }),
                });
            }
        }

        // Report transition before we propagate event across layers
        this.handler.connectionStateChanged(this._connectionState, oldState, reason);
    }

    public initProtocol(protocol: IProtocolHandler) {
        protocol.quorum.on("addMember", (clientId, _details) => {
            this.receivedAddMemberEvent(clientId);
        });

        protocol.quorum.on("removeMember", (clientId) => {
            this.receivedRemoveMemberEvent(clientId);
        });

        // if we have a clientId from a previous container we need to wait for its leave message
        if (this.clientId !== undefined && protocol.quorum.getMember(this.clientId) !== undefined) {
            this.prevClientLeftTimer.restart();
        }
    }
}
