import * as kafka from "kafka-node";
import * as _ from "lodash";
import { Collection, MongoClient } from "mongodb";
import * as nconf from "nconf";
import * as path from "path";
import * as core from "../core";
import * as utils from "../utils";
import { TakeANumber } from "./takeANumber";

// Setup the configuration system - pull arguments, then environment variables
nconf.argv().env(<any> "__").file(path.join(__dirname, "../../config.json")).use("memory");

const mongoUrl = nconf.get("mongo:endpoint");
const zookeeperEndpoint = nconf.get("zookeeper:endpoint");
const kafkaClientId = nconf.get("deli:kafkaClientId");
const receiveTopic = nconf.get("deli:topics:receive");
const sendTopic = nconf.get("deli:topics:send");
const checkpointBatchSize = nconf.get("deli:checkpointBatchSize");
const objectsCollectionName = nconf.get("mongo:collectionNames:objects");
const groupId = nconf.get("deli:groupId");

async function processMessages(kafkaClient: kafka.Client, producer: kafka.Producer, objectsCollection: Collection) {
    const dispensers: { [key: string]: TakeANumber } = {};

    const consumerGroup = new kafka.ConsumerGroup({
            autoCommit: false,
            fromOffset: "earliest",
            groupId,
            host: zookeeperEndpoint,
            id: kafkaClientId,
            protocol: ["roundrobin"],
        },
        [receiveTopic]);
    consumerGroup.on("error", (error) => {
        console.error(error);
    });
    consumerGroup.on("offsetOutOfRange", (error) => {
        console.error(error);
    });

    const consumerOffset = new kafka.Offset(kafkaClient);
    const partitionManager = new core.PartitionManager(
        groupId,
        receiveTopic,
        consumerOffset,
        checkpointBatchSize);
    let ticketQueue: {[id: string]: Promise<void> } = {};

    console.log("Waiting for messages");
    consumerGroup.on("message", async (message: any) => {
        const baseMessage = JSON.parse(message.value) as core.IMessage;

        if (baseMessage.type === core.UpdateReferenceSequenceNumberType ||
            baseMessage.type === core.RawOperationType) {

            const objectMessage = JSON.parse(message.value) as core.IObjectMessage;
            const objectId = objectMessage.objectId;

            // Go grab the takeANumber machine for the objectId and mark it as dirty.
            // Store it in the partition map. We need to add an eviction strategy here.
            if (!(objectId in dispensers)) {
                dispensers[objectId] = new TakeANumber(objectId, objectsCollection, producer, sendTopic);
                console.log(`Brand New object Found: ${objectId}`);
            }
            const dispenser = dispensers[objectId];

            // Either ticket the message or update the sequence number depending on the message type
            const ticketP = dispenser.ticket(message);
            ticketQueue[objectId] = ticketP;

            // Update partition manager entry.
            partitionManager.update(message.partition, message.offset);

            // Periodically checkpoints to mongo and checkpoints offset back to kafka.
            // Ideally there should be a better strategy to figure out when to checkpoint.
            if (message.offset % checkpointBatchSize === 0) {
                // Ticket all messages and empty the queue.
                let pendingTickets = _.values(ticketQueue);
                ticketQueue = {};
                await Promise.all(pendingTickets);

                // Checkpoint to mongo now.
                let checkpointQueue = [];
                for (let doc of Object.keys(dispensers)) {
                    checkpointQueue.push(dispensers[doc].checkpoint());
                }
                await Promise.all(checkpointQueue);

                // Finally call kafka checkpointing.
                partitionManager.checkPoint();
            }
        }
    });
}

async function run() {
    // Connection to stored document details
    const client = await MongoClient.connect(mongoUrl);
    console.log("Connected to Mongo");
    const objectsCollection = await client.collection(objectsCollectionName);
    console.log("Collection ready");

    // Prep Kafka connection
    let kafkaClient = new kafka.Client(zookeeperEndpoint, kafkaClientId);
    let producer = new kafka.Producer(kafkaClient, { partitionerType: 3 });

    // Return a promise that will never resolve (since we run forever) but will reject
    // should an error occur
    return new Promise<void>((resolve, reject) => {
        producer.on("error", (error) => {
            reject(error);
        });

        producer.on("ready", () => {
            utils.kafka.ensureTopics(kafkaClient, [sendTopic, receiveTopic])
                    .then(() => processMessages(kafkaClient, producer, objectsCollection))
                    .catch((error) => reject(error));
        });
    });
}

// Start up the deli service
console.log("Starting");
const runP = run();
runP.catch((error) => {
    console.error(error);
    process.exit(1);
});
