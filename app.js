const os = require('os');
const fs = require('fs');

const express = require('express');
const path = require("path");

const { Liquid } = require('liquidjs');

const VerusRPC = require('./verusrpc.js')
const VerusPROC = require('./verusproc.js');

const api = require('./api_router.js');

const config = require('./config.json');
const explorers = require('./explorers.json');

const { argv } = require('node:process');

// INIT OBJECTS
const app = express();
const engine = new Liquid({
  root: __dirname, // for layouts and partials
  extname: '.liquid'
})

/// ---------------------------------------------

app.engine('liquid', engine.express()) // register liquid engine
app.set('views', ['./partials', './views']) // specify the views directory
app.set('view engine', 'liquid') // set to default

// timeago jquery plugin
app.use('/js', express.static(path.join(__dirname, 'libs')))

// bootstrap
app.use('/css', express.static(path.join(__dirname, 'node_modules/bootstrap/dist/css')))

app.use('/js', express.static(path.join(__dirname, 'node_modules/bootstrap/dist/js')))
app.use('/js', express.static(path.join(__dirname, 'node_modules/jquery/dist')))
app.use('/js', express.static(path.join(__dirname, 'node_modules/@popperjs/core/dist/umd')))
app.use('/js', express.static(path.join(__dirname, 'node_modules/@fortawesome/fontawesome-free/js')))

// font-awesome
app.use('/css', express.static(path.join(__dirname, 'node_modules/@fortawesome/fontawesome-free/css')))
app.use('/js', express.static(path.join(__dirname, 'node_modules/@fortawesome/fontawesome-free/js')))

app.use('/sprites', express.static(path.join(__dirname, 'node_modules/@fortawesome/fontawesome-free/sprites')))
app.use('/svgs', express.static(path.join(__dirname, 'node_modules/@fortawesome/fontawesome-free/svgs')))

app.use('/webfonts', express.static(path.join(__dirname, 'node_modules/@fortawesome/fontawesome-free/webfonts')))

app.use('/scss', express.static(path.join(__dirname, 'node_modules/@fortawesome/fontawesome-free/scss')))
app.use('/less', express.static(path.join(__dirname, 'node_modules/@fortawesome/fontawesome-free/less')))

// amcharts5
app.use('/lib/5', express.static(path.join(__dirname, 'amcharts5.5.7')))


app.use('/', api)


/// ---------------------------------------------
/// main entry point
/// ---------------------------------------------
function getVerusConf() {
  // known Linux path to verus config
  let vrsccfile = os.homedir() + "/.komodo/VRSC/VRSC.conf";
  let vrsctestcfile = os.homedir() + "/.komodo/vrsctest/vrsctest.conf";

  if (!fs.existsSync(vrsccfile) && !fs.existsSync(vrsctestcfile)) {
    console.error("verus conf file was not found");
    return undefined;
  }
  if (fs.existsSync(vrsccfile)) {    
    let text = fs.readFileSync(vrsccfile, 'utf8');
    let rows = text.split('\n');
    let result = {};
    for (let i in rows) {
      let items = rows[i];
      let s = items.split('=');
      let key = s[0];
      let val = s[1];
      if (key && key.length > 0 && val && val.length > 0) {
        result[key] = val;
      }
    }
    return result;
  }
  if (fs.existsSync(vrsctestcfile)) {    
    let text = fs.readFileSync(vrsctestcfile, 'utf8');
    let rows = text.split('\n');
    let result = {};
    for (let i in rows) {
      let items = rows[i];
      let s = items.split('=');
      let key = s[0];
      let val = s[1];
      if (key && key.length > 0 && val && val.length > 0) {
        result[key] = val;
      }
    }
    return result;
  }
  return undefined;
}


// GLOBALS 
var vconf;
var vrpc;
var vproc;


async function startApp() {

  vconf = getVerusConf();
  if (!vconf) {
    vconf = {};
    console.log("Using daemon rpc details from config.json");
  }

  let verbose = config.verbose || 0;
  argv.forEach((val, index) => {
    console.log(`${index}: ${val}`);
    if (val.indexOf("verbose") > -1) {
      verbose++;
    }
  });

  const listenport = config.listenport || 8080;

  const rpchost = vconf.rpchost || config.rpchost || "127.0.0.1";
  const rpcport = vconf.rpcport || config.rpcport || 27486;
  const rpcuser = vconf.rpcuser || config.rpcuser || "user";
  const rpcpass = vconf.rpcpassword || config.rpcpassword || "pass";

  let daemon_url = "http://" + rpchost + ":" + rpcport;

  vrpc = new VerusRPC(daemon_url, rpcuser, rpcpass, verbose);
  vproc = new VerusPROC(config, vrpc, api, verbose);
  
  await vrpc.init();
  await vproc.initPlugins();

  console.log("Connecting to daemon url", daemon_url);

  // wait for verusd to become available
  let start = Date.now();
  let verus = await vrpc.waitForOnline();
  let end = Date.now();
  let waitDiff = end - start;

  if (verus.online) {
    if (verus.blocks != verus.longestchain) {
      console.log("verusd", "v"+verus.VRSCversion, "syncing to block", verus.longestchain, "from", verus.blocks);
    } else {
      console.log("verusd", "v"+verus.VRSCversion, "running at block", verus.blocks);
    }
    if (waitDiff > 21000) {
      console.log("verusd may have been launching, took longer than expected", waitDiff + "ms");
    }

    // pass config and verusrpc to api
    await api.init(vrpc);
    
    console.log("Caching currencies...");

    await vrpc.getInfo(false);
    
    // initially cache currencies
    await vrpc.listCurrencies([{systemtype:"pbaas"}], false);
    await vrpc.listCurrencies([{systemtype:"gateway"}], false);
    await vrpc.listCurrencies([], false);
    await vrpc.listCurrencies([{systemtype:"imported"}], false);

    // start verus processor
    await vproc.start();
  
    // ready to listen for clients to serve
    app.listen(listenport, () => {
      console.log(`Listening on port ${listenport}`)
    })

  } else {
    console.log("Error, unable to connect to rpc daemon");
  }

}

console.log("--------------------------------------------");
console.log(" VerusRPC");
console.log("--------------------------------------------");

startApp();