const { EventHubProducerClient } = require("@azure/event-hubs");
const identity = require("@azure/identity");
const credential = new identity.DefaultAzureCredential();
const eventHubNamespace = "sonic-build.servicebus.windows.net";
const eventHubName = "githubevent";
var producer = null;

async function getProducer(){
    
    if (producer == null){
        producer = new EventHubProducerClient(eventHubNamespace, eventHubName, credential);
    };

    return producer;
}

async function sendEventBatch(eventDatas, app)
{
    if (producer == null){
        producer = new EventHubProducerClient(eventHubNamespace, eventHubName, credential);
    };
    const batch = await producer.createBatch();
    eventDatas.forEach(eventData => {
        if (!batch.tryAdd(eventData)){
            app.log.error("[ EVENTHUB ] Failed to add eventData");
        }
    });
    let rc = await producer.sendBatch(batch);
    app.log.info(`[ EVENTHUB ] ${rc}`)
}

function init(app)
{
    app.log.info('eventhub init');
    app.onAny(async (context) => {
        let dateString = new Date().toISOString()
        app.log.info(`[ EVENTHUB ] timestamp: ${dateString}, event: ${context.name}, action: ${context.payload.action}`);

        var eventDatas = [];
        var eventData = {
            body: {"Timestamp": dateString, "Name": context.name, "Action": context.payload.action, "Payload": context.payload}
        };
        eventDatas.push(eventData);
        await sendEventBatch(eventDatas, app);
      });
}

module.exports = Object.freeze({
    init: init,
    sendEventBatch: sendEventBatch,
});