import "jsr:@std/dotenv/load";

const CLIENT_ID = Deno.env.get("CLIENT_ID");
const BOT_TOKEN = Deno.env.get("BOT_TOKEN");

if (CLIENT_ID === undefined || BOT_TOKEN === undefined) {
  console.error("CLIENT_ID and BOT_TOKEN must be defined.");
  Deno.exit(1);
}

const url = `https://discord.com/api/v8/applications/${CLIENT_ID}/commands`;

const rollConfig = {
  description: "Evaluate dice notation",
  options: [
    {
      name: "dice",
      description: "The dice notation to evaluate, e.g. 4d6kH3",
      type: 3,
      required: true,
    },
    {
      name: "whisper",
      description: "If set, only you will see the result",
      type: 5,
    },
  ],
};

const config = {
  method: "PUT",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bot ${BOT_TOKEN}`,
  },
  body: JSON.stringify([
    { name: "roll", ...rollConfig },
    { name: "r", ...rollConfig },
    {
      name: "sync",
      description: "Sync a character sheet from Ashworth",
      options: [
        {
          name: "id",
          description: "An Ashworth sheet ID",
          type: 3,
        },
      ],
    },
  ]),
};

await fetch(url, config);
