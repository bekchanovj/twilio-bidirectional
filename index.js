const PlayHT = require("playht");

const WebSocket = require("ws");

const express = require("express");
const WaveFile = require("wavefile").WaveFile;

const path = require("path")
const app = express();
const server = require("http").createServer(app);
const wss = new WebSocket.Server({ server });
const OPENAI_API_KEY = '';
const PLAYHT_USER_ID = '';
const PLAYHT_API_KEY = '';



let chunks = [];

// Handle Web Socket Connection
wss.on("connection", function connection(ws) {
  console.log("New Connection Initiated");
  PlayHT.init({
    apiKey: '',
    userId: '',
  });
  console.log(PlayHT.apiKey, PlayHT.userId);

  ws.on("message", async function incoming(message) {
    const msg = JSON.parse(message);
    streamSid = msg.streamSid;
    switch (msg.event) {
      case "connected":
        console.log(`A new call has connected.`);
        break;
      case "start":
        console.log(`Starting Media Stream ${msg.streamSid}`);
        break;
      case "media":
        const streamFromStream = await PlayHT.stream('Hi', {
          voiceEngine: 'PlayHT2.0-turbo',
          voiceId: 's3://peregrine-voices/oliver_narrative2_parrot_saad/manifest.json',
          outputFormat: 'mulaw',
          sampleRate: 8000,
        });
      
        streamFromStream.on('data', (data) => {
          const message = JSON.stringify({
            event: 'media',
            streamSid,
            media: {
              payload: data.toString('base64'),
            },
          });
          
          ws.send(message);
        });
        const twilioData = msg.media.payload;
        // Build the wav file from scratch since it comes in as raw data
        let wav = new WaveFile();

        // Twilio uses MuLaw so we have to encode for that
        wav.fromScratch(1, 8000, "8m", Buffer.from(twilioData, "base64"));
        
        // This library has a handy method to decode MuLaw straight to 16-bit PCM
        wav.fromMuLaw();
        
        // Get the raw audio data in base64
        const twilio64Encoded = wav.toDataURI().split("base64,")[1];
        
        // Create our audio buffer
        const twilioAudioBuffer = Buffer.from(twilio64Encoded, "base64");
                    
        // Send data starting at byte 44 to remove wav headers so our model sees only audio data
        chunks.push(twilioAudioBuffer.slice(44));
                    
        // We have to chunk data b/c twilio sends audio durations of ~20ms and AAI needs a min of 100ms
        if (chunks.length >= 5) {
          const audioBuffer = Buffer.concat(chunks);
          const encodedAudio = audioBuffer.toString("base64");
          //assembly.send(JSON.stringify({ audio_data: encodedAudio }));
          chunks = [];
        }
        break;
      case "stop":
        console.log(`Call Has Ended`);
        break;
    }
  });
});


//Handle HTTP Request
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "/index.html")));

app.post("/", async (req, res) => {
  
    res.set("Content-Type", "text/xml");
    res.send(
      `<Response>
         <Connect>
           <Stream url='wss://${req.headers.host}' />
         </Connect>
       </Response>`
    );
  });

// Start server
console.log("Listening at Port 8080");
server.listen(8080);