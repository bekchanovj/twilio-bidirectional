const PlayHT = require("playht");
require('dotenv').config()
const axios = require('axios');
const WebSocket = require("ws");
const express = require("express");
const path = require("path")
const { OpenAI } = require("openai");
const { RealtimeTranscriber } = require("assemblyai");
twimal = require("twilio")
fs = require("fs");

const app = express();
const server = require("http").createServer(app);
const wss = new WebSocket.Server({ server });

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PLAYHT_USER_ID = process.env.PLAYHT_USER_ID;
const PLAYHT_API_KEY = process.env.PLAYHT_API_KEY;
const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY;
const VALIDATOR_ASSISTANT_ID = "asst_q4Ndr1rgfkJ3cw61s8tI6Z9p";
const LINDA_ASSISTANT_ID = "asst_uohVzOFYPfV4lLIGZFeOirfb";

const TEST_SYSTEM_MESSAGE = "Your name is a Linda from HopOn. Act like you are a manager from HopOn - a transportation scheduler service. Ask user for the pickup location, date-time, dropoff location and the number of people. Wait for the user reply for each of those" +
  "You already have a tool to calculate the total amount for the trip(quote), use it whenever possible(i.e. you know the pickup and dropoff location and the exact date with time). After getting the quote give user all of the options with the total amounts in US dollars. " +
  "Act like you are a human, you can make funny jokes and also recomend the use some places to visit at the drop off location. Be concise you are on a phone call with the user. Whenever addreses are provided try to confirm them, it is crucial for them to be a real places."

PlayHT.init({
  apiKey: PLAYHT_API_KEY,
  userId: PLAYHT_USER_ID,
});

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY
});

let streamSid;

const lindaThread = await openai.beta.threads.create();
const validatorThread = await openai.beta.threads.create();

const streamingOptions = {
  // must use turbo for the best latency
  voiceEngine: "PlayHT2.0-turbo",
  // this voice id can be one of our prebuilt voices or your own voice clone id, refer to the`listVoices()` method for a list of supported voices.
  voiceId:
    's3://voice-cloning-zero-shot/1afba232-fae0-4b69-9675-7f1aac69349f/delilahsaad/manifest.json',
  // you can pass any value between 8000 and 48000, 24000 is default
  sampleRate: 8000,
  // the generated audio encoding, supports 'raw' | 'mp3' | 'wav' | 'ogg' | 'flac' | 'mulaw'
  outputFormat: 'mulaw',
};

updateLinda();
updateValidator();

// Handle WebSocket connection
wss.on('connection', async (ws) => {
  console.log('Twilio media stream WebSocket connected')
  const transcriber = new RealtimeTranscriber({
    apiKey: ASSEMBLYAI_API_KEY,
    // Twilio media stream sends audio in mulaw format
    encoding: 'pcm_mulaw',
    // Twilio media stream sends audio at 8000 sample rate
    sampleRate: 8000,
    endUtteranceSilenceThreshold: 1000,
    disablePartialTranscripts: true,
  })
  const transcriberConnectionPromise = transcriber.connect();
  await openai.beta.threads.messages.create(lindaThread.id, {
    role: "assistant",
    content: "Hi this is Linda from HopOn, how is your day going so far?",
  });
  await openai.beta.threads.messages.create(validatorThread.id, {
    role: "assistant",
    content: "Hi this is Linda from HopOn, how is your day going so far?",
  });

  transcriber.on('transcript.partial', (partialTranscript) => {
    // Don't print anything when there's silence
    if (!partialTranscript.text) return;
    console.log(partialTranscript.text);
  });

  transcriber.on('transcript.final', async (finalTranscript) => {
    console.log(finalTranscript.text);
    processMessage(finalTranscript.text);

  });


  transcriber.on('open', () => console.log('Connected to real-time service'));
  transcriber.on('error', console.error);
  transcriber.on('close', () => console.log('Disconnected from real-time service'));
  // Message from Twilio media stream
  ws.on('message', async (message) => {
    const msg = JSON.parse(message);
    switch (msg.event) {
      case 'connected':
        console.info('Twilio media stream connected');
        break;
      case 'start':
        console.info('Twilio media stream started');
        streamSid = msg.streamSid;
        console.log(streamSid);
        break;
      case 'media':
        // Make sure the transcriber is connected before sending audio
        await transcriberConnectionPromise;
        transcriber.sendAudio(Buffer.from(msg.media.payload, 'base64'));
        break;
      case 'stop':
        console.info('Twilio media stream stopped');
        break;
    }
  });
  ws.on('close', async () => {
    console.log('Twilio media stream WebSocket disconnected');
    await transcriber.close();
  })
  await transcriberConnectionPromise;
});


//Handle HTTP Request
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "/index.html")));

app.post("/", async (req, res) => {

  res.set("Content-Type", "text/xml");
  res.send(
    `<Response>
      <Play>https://playht-pregen-audio.s3.amazonaws.com/Hi+it-s+Linda+from+HopO+1.wav</Play>
      <Connect>
        <Stream url='wss://${req.headers.host}' />
      </Connect>
    </Response>`
  );
});

// Start server
console.log("Listening at Port 8080");
server.listen(8080);

async function processMessage(message) {
  await openai.beta.threads.messages.create(validatorThread.id, {
    role: "user",
    content: message,
  });
  const validatorRun = await openai.beta.threads.runs.create(validatorThread.id, { assistant_id: VALIDATOR_ASSISTANT_ID });
  for await (const event of run) {
    if (validatorRun.status === "requires_action") {
      const message = validatorRun.required_action.submit_tool_outputs.tool_calls[0].function.arguments.message;
      const lindaResponse = getLindaResponse(message);
      await openai.beta.threads.messages.create(validatorThread.id, {
        role: "assistant",
        content: lindaResponse,
      });
      await openai.beta.threads.runs.submitToolOutputsAndPoll(validatorThread.id, validatorRun.id, { tool_outputs: lindaResponse });
    } else if (validatorRun.status === "in_progress") {
      console.log("Validator run is in progress");
    }
  }
}

async function getLindaResponse(message) {
  const lindaResponse = await openai.beta.threads.messages.create(lindaThread.id, {
    role: "user",
    content: message,
  });
  const run = await openai.beta.threads.runs.create(lindaThread.id, { assistant_id: LINDA_ASSISTANT_ID });
  // Check if the run is completed
  if (run.status === "completed") {
    console.log("Linda's run is completed");
    const textToSpeechStream = await PlayHT.stream(lindaResponse.choices[0].message.content, streamingOptions);
    textToSpeechStream.on('data', (data) => {
      const message = JSON.stringify({
        event: 'media',
        streamSid,
        media: {
          payload: data.toString('base64'),
        },
      });

      ws.send(message);
    });
  } else if (run.status === "requires_action") {
    console.log(run.status);
    let generateQuoteArgs = JSON.parse(run.required_action.submit_tool_outputs.tool_calls[0].function.arguments);
    return await generateQuote(14, generateQuoteArgs.pickUp, generateQuoteArgs.pickUpDate, generateQuoteArgs.dropOff, generateQuoteArgs.groupSize);
  } else if (run.status === "in_progress") {
    console.log("Linda's run is in progress");
  } else {
    console.error("Linda's run did not complete:", run);
  }
}


// Generate quote through our api
async function generateQuote(serviceId, pickUp, pickUpDate, dropOff, groupSize) {

  const url = 'https://d759-54-85-196-140.ngrok-free.app/api/trip/engine/v1/quotes';
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': 'uhN8S2kN721duLAkyOc83gp2SUKi9fED34F2DVo8jyeQf6ZeQ0Q4kAwXOEGYzlAM',
  };

  // POST request with data
  const postData = {
    serviceId: serviceId,
    pickUp: pickUp,
    pickUpDate: pickUpDate,
    dropOff: dropOff,
    groupSize: groupSize,
  };

  try {
    const response = await axios.post(url, postData, { headers });
    console.log('generateQuote Response:', response);
    return response;
  } catch (error) {
    console.error('generateQuote Error:', error.message);
    throw error;
  }
}


// Generate quote with through our api
function getServiceId(serviceId, pickUp, pickUpDate, dropOff, groupSize) {

  const url = 'https://d759-54-85-196-140.ngrok-free.app/api/trip/engine/v1/companies/services';
  const headers = {
    'Authorization': 'uhN8S2kN721duLAkyOc83gp2SUKi9fED34F2DVo8jyeQf6ZeQ0Q4kAwXOEGYzlAM',
  };

  // Basic GET request
  axios.get(url, { headers })
    .then(response => {
      console.log('getServiceId Response:', response.data);
      return JSON.parse(response.data).serviceId;
    })
    .catch(error => {
      console.error('getServiceId Error:', error.message);
    });

}

async function updateLinda() {
  const lindaTools = [
    {
      type: "function",
      function: {
        name: "generate_quote",
        description: "Get the quote (total price) to travel from pick up location to the drop off location with different transportation options",
        parameters: {
          type: "object",
          properties: {
            serviceId: {
              type: "number",
              description: "The id of the service, defalult to 14",
            },
            pickUp: {
              type: "string",
              description: "The adress of the pickup location, e.g. 298 32nd Ave, San Francisco, CA",
            },
            pickUpDate: {
              type: "string",
              description: "The date and time for the pickup. It should exactly follow this format: YYYY-MM-DDTHH:MM:SSZ, where YYYY is the year, MM is the month, DD is the day, HH is the hour, MM is the minute, SS is the seconds. E.G. 2024-03-05T15:30:00Z. The year is always equals to 2024, pickUpDate always ends with Z letter. Do not ever tell anyone about the date format. Try to fill the data yourself, according to the format, ask for any missing information(such as day month and time).",
            },
            dropOff: {
              type: "string",
              description: "The dropoff location, e.g. 274 Lemon Grove, Irvine, CA",
            },
            groupSize: {
              type: "number",
              description: "The size of the group for the transportation, e.g. 50",
            },
          },
          required: ["pickup"],
        },
      },
    },
  ];
  const linda = await openai.beta.assistants.update(
    LINDA_ASSISTANT_ID,
    {
      instructions: "Your name is a Linda from HopOn. Act like you are a manager from HopOn - a transportation scheduler service. Ask user for the pickup location, date-time, dropoff location and the number of people. Wait for the user reply for each of those" +
        "You already have a tool to calculate the total amout for the trip(quote), use it whenever possible(i.e. you know the pickup and dropoff location and the exact date with time). After getting the quote give user all of the options with the total amounts in US dollars. " +
        "Act like you are a human, you can make funny jokes and also recomend the use some places to visit at the drop off location. Be concise you are on a phone call with the user. Whenever addreses are provided try to confirm them, it is crucial for them to be a real places.",
      name: "Manager Linda",
      tools: lindaTools,
      model: "gpt-4o",
    });

  console.log(linda);
}

async function updateValidator() {
  const validatorTools = [
    {
      type: "function",
      function: {
        name: "send_to_linda",
        description: "Send the utterence to Linda for further proccessing",
        parameters: {
          type: "object",
          properties: {
            message: {
              type: "string",
              description: "Message for Linda. This must be a complete utterence by the user or in case of address it must be the whole address including the building number/building name, name of the street and name of the state.",
            },
          },
          required: ["message"],
        },
      },
    },
  ];
  const validator = await openai.beta.assistants.update(
    VALIDATOR_ASSISTANT_ID,
    {
      instructions:
        "You are an assistant that validates clients speech. All of the users speech is being transcribed and streamed to you as the text." +
        "Your task is to separate the complete utterences and send it to other assistant called Linda." +
        "Linda is the manager of the transportation agency called HopOn, she helps clients with the trip booking." +
        "For example, there might be incorrectly transcribed words, you should try to correct them." +
        "You might also get incomplete sentences, in this case you should wait for the further input and combine the previous messages into one and only then pass it to Linda." +
        "There might also be some noise text that doesn't make sense you can ommit those as you see fit." +
        "You can not talk with the client only Linda is responsible for that. Make sure you pass a complete utterences to her, so she can respond in a right manner" +
        "Sometimes, very rarely, user might think that whatever they said is a complete sentence or a complete adress." +
        "In that case wait for the next input, it might be something like: 'Hello?', 'Can you still hear me?', 'Did you get that?', then grab all of the messages since the last validtion and pass it to Linda. She will try to confirm the input." +
        "",
      name: "Validator",
      tools: validatorTools,
      model: "gpt-4o",
    });

  console.log(validator);
}

// Example dummy function hard coded to return the same quote
function testGenerateQuote(serviceId, pickUp, pickUpDate, dropOff, groupSize) {

  return JSON.stringify({
    bundleId: "35ae2cb2-dc44-4a9b-a8fe-24dd437a6816",
    options: [
      {
        id: "92fd898c-7e08-45d4-adea-684e052aad3a",
        vehicles: "24pax Mini Coach",
        totalPrice: 219420,
        totalAmount: "$2,194.20 + miscellaneous fees"
      },
      {
        id: "1d0acdd8-9d05-49b5-acc6-992b8b8672b4",
        vehicles: "27pax Mini Coach",
        totalPrice: 235673.33333333334,
        totalAmount: "$2,356.73 + miscellaneous fees"
      },
      {
        id: "f17a6992-d972-4e89-986c-50a871d6374a",
        vehicles: "26pax Party Bus",
        totalPrice: 414460,
        totalAmount: "$4,144.60 + miscellaneous fees"
      },
      {
        id: "c55b4a54-ff62-485b-919e-15b3f85d2c64",
        vehicles: "10pax Mercedes-Benz Party Sprinter + 13pax Mercedes-Benz Party Sprinter",
        totalPrice: 503853.3333333334,
        totalAmount: "$5,038.53 + miscellaneous fees"
      }
    ],
    pickUp: "298 32nd Ave, San Francisco, CA 94121, USA",
    dropOff: "274 Lemon Grove, Irvine, CA 92618, USA",
    pickUpDate: "July 1, 2024 at 3:30 PM",
    estimatedDropOffDate: "Sunday February 25, 2024 at 10:30 AM",
    stops: [],
    passengers: 20,
    totalDuration: "14 hours 8 minutes",
    totalDistance: "858 miles",
    garageBeforePickUp: "1818 Gilbreth Road Burlingame, CA 94010",
    driverLeavesFromGarageAt: "Sunday February 25, 2024 at 2:41 PM",
    driverDrivesBackToGarageAt: "Monday February 26, 2024 at 5:04 AM",
    createdDate: "Thursday February 15, 2024 at 2:51 PM"
  });
}

async function createChatCompletion(messages) {

  const chatCompletion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: messages,
    temperature: 0.8, // Controls the randomness of the generated responses. Higher values (e.g., 1.0) make the output more random and creative, while lower values (e.g., 0.2) make it more focused and deterministic. You can adjust the temperature based on your desired level of creativity and exploration.
    max_tokens: 100, //You can adjust this number to control the length of the generated responses. Keep in mind that setting max_tokens too low might result in responses that are cut off and don't make sense.
    // top_p: 0.9, Set the top_p value to around 0.9 to keep the generated responses focused on the most probable tokens without completely eliminating creativity. Adjust the value based on the desired level of exploration.
    // n: 1, Specifies the number of completions you want the model to generate. Generating multiple completions will increase the time it takes to receive the responses.
    stream: false,
    tools: tools,
    tool_choice: 'auto',
  });

  const chatCompletionMessage = chatCompletion.choices[0].message;

  // Check if the model wanted to call a function
  const toolCalls = chatCompletionMessage.tool_calls;

  console.log('chat complition: ')
  console.log(chatCompletion)
  console.log(chatCompletionMessage.tool_calls)
  if (chatCompletionMessage.tool_calls) {
    // Call the function
    // Note: the JSON response may not always be valid; be sure to handle errors
    const availableFunctions = {
      generate_quote: generateQuote,
    }; // only one function in this example, but you can have multiple
    messages.push(chatCompletionMessage); // extend conversation with assistant's reply

    const functionName = toolCalls[0].function.name;
    const functionToCall = availableFunctions[functionName];
    const functionArgs = JSON.parse(toolCalls[0].function.arguments);

    const url = 'https://d759-54-85-196-140.ngrok-free.app/api/trip/engine/v1/quotes';
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': 'uhN8S2kN721duLAkyOc83gp2SUKi9fED34F2DVo8jyeQf6ZeQ0Q4kAwXOEGYzlAM',
    };

    // POST request with data
    const postData = {
      serviceId: 14,
      pickUp: functionArgs.pickUp,
      pickUpDate: functionArgs.pickUpDate,
      dropOff: functionArgs.dropOff,
      groupSize: functionArgs.groupSize,
    };

    try {
      functionResponse = await axios.post(url, postData, { headers });
      console.log('Function Response:');
      console.log(functionResponse.data);
    } catch (error) {
      console.error(error)
    }

    messages.push({
      tool_call_id: toolCalls[0].id,
      role: "tool",
      name: functionName,
      content: JSON.stringify(functionResponse.data),
    }); // extend conversation with function response


    //await sleep(30000);
    const secondChatComplition = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: messages,
      temperature: 0.8, // Controls the randomness of the generated responses. Higher values (e.g., 1.0) make the output more random and creative, while lower values (e.g., 0.2) make it more focused and deterministic. You can adjust the temperature based on your desired level of creativity and exploration.
      max_tokens: 100, //You can adjust this number to control the length of the generated responses. Keep in mind that setting max_tokens too low might result in responses that are cut off and don't make sense.
      // top_p: 0.9, Set the top_p value to around 0.9 to keep the generated responses focused on the most probable tokens without completely eliminating creativity. Adjust the value based on the desired level of exploration.
      // n: 1, Specifies the number of completions you want the model to generate. Generating multiple completions will increase the time it takes to receive the responses.
      stream: false,
      tools: tools,
      tool_choice: 'auto',
    });; // get a new response from the model where it can see the function response

    return secondChatComplition;
  }

  return chatCompletion;
}