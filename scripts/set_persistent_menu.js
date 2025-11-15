require('dotenv').config();
const axios = require('axios');

const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
if (!PAGE_ACCESS_TOKEN) {
  console.error('PAGE_ACCESS_TOKEN missing in .env');
  process.exit(1);
}

const payload = {
  "persistent_menu":[
    {
      "locale":"default",
      "composer_input_disabled": false,
      "call_to_actions":[
        {
          "title":"Presentar denuncia",
          "type":"postback",
          "payload":"PRESENTAR_DENUNCIA"
        },
        {
          "title":"Consultar estado",
          "type":"postback",
          "payload":"CONSULTAR_ESTADO"
        },
        {
          "title":"Hablar con un operador",
          "type":"postback",
          "payload":"OPERADOR"
        }
      ]
    }
  ],
  "get_started": { "payload":"GET_STARTED" }
};

async function setMenu(){
  try {
    await axios.post(`https://graph.facebook.com/v17.0/me/messenger_profile?access_token=${PAGE_ACCESS_TOKEN}`, payload);
    console.log('Persistent menu y Get Started creados');
  } catch (err) {
    console.error('Error set menu:', err.response ? err.response.data : err.message);
  }
}
setMenu();
