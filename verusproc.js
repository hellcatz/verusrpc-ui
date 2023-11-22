const fs = require('fs');

const https = require("node:https");

const coinpaprikaids = require("./coinpaprika.json");

const PLUGINS_DIR = "./plugins";
var plugins = {}

// scans verusd for balances, and things ...
class VerusPROC {
    constructor(rpc, api, verbose=0) {
        this.verus = rpc;
        this.api = api;
        this.verbose = verbose;
                
        this.running = false;
        this.executing = false;
        this.interval = 5000;
        
        this.templateCacheInterval = 120000; // 2 minute re-cache if no blocks
        this.lastTemplateCache = 0;
        
        this.lastBlock = 0;
    }
        
    async getHttpsResponse(url) {
      let p = new Promise((resolve, reject) => {
        let rawData = '';
        https.get(url, (res) => {
          res.setEncoding('utf8');
          res.on('data', (chunk) => { rawData += chunk; });
          res.on('end', () => { resolve(rawData); });
        }).on('error', (e) => {
          console.error("https.get("+url+") failed:", e);
          resolve(rawData);
        });
      });
      return await p;
    }
    
    async getCoinPaprikaTickers() {
      // if currency id is known currency on coinpaprika
      let j = undefined;
      let r = await this.getHttpsResponse("https://api.coinpaprika.com/v1/tickers?quotes=BTC,USD");
      try {
        j = JSON.parse(r)
        if (j.error && j.type && j.soft_limit) {
          console.log("coinpaprika.error", j.type, j.soft_limit, "blocked for", j.block_duration);
          j = undefined;
        } else if (j.error) {
          console.log("coinpaprika.error", j.error);
          j = undefined;
        }
      } catch {
        j = undefined;
      }
      return j;
    }

    async monitorConversions() {
      // monitor conversions
      let conversions = this.verus.get_conversions();
      for (let i in conversions) {
        let c = conversions[i];
        
        // BUG fix work-around
        if (c.closedby && c.closedby.closed != c.uid) {
          console.log("!!! BUG !!! Conversion Monitor BUG closedby uid mismatch", c.uid, c.closedby.closed);
          // this was used to clean out a bad history file while testing the bug
          //c.closedby = undefined;
        }
        
        // check to see if this conversion is the reverse of a previous conversion
        let matches = this.verus.get_conversion_by_details(c.convertto, c.currency, c.destination, c.amount, 0.5);
        if (matches.length > 0) {
          for (let i in matches) {
            // built in sanity to prevent older txid closing newer
            if (c.started > matches[i].started) {
              // if the match hasn't been closed or we closed it
              if (!matches[i].closedby || (matches[i].closedby && matches[i].closedby.uid == c.uid)) {
                // if we haven't already closed a match or this match is the one we closed
                if (!c.closed || (c.closed && c.closed == matches[i].uid)) {
                  // keep object updated to track progress
                  c.closed = matches[i].uid;
                  matches[i].closedby = c;
                  // only close if we haven't closed
                  if (matches[i].status !== "closed") {
                    matches[i].status="closed";
                    console.log("conversion position closed", matches[i].uid, "with", c.uid, c);
                  }
                }
              }
            }
          }
        }
        // check conversions for progress
        if (c.status !== "closed") {
          // do some estimates
          if (c.status == "success" || c.estimate) {
            // estimate converting back
            let e = await this.verus.estimateConversion(c.received||c.estimate, c.convertto, c.currency, c.via, false);
            if (e) {
              c.estimate_reverse = e.estimatedcurrencyout;
            }
          }
          
          // check spentTxId's for progress
          if (c.spentTxId2) {
            let tx = await this.verus.getRawTransaction(c.spentTxId2, false, false);
            if (!tx || tx.error) {
              console.log("failed to get spentTxId2 for conversion! falling back ...");
            } else {
              continue;
            }
          }
          if (c.spentTxId) {
            let tx = await this.verus.getRawTransaction(c.spentTxId, false, false);
            if (!tx || tx.error) {
              console.log("failed to get spentTxId for conversion! falling back ...");
            } else {
              continue;
            }
          }
          console.log("checking conversion txid for progress", c.txid);
          await this.verus.getRawTransaction(c.txid, false, false);
        }
      }
    }
    
    async cacheCoinPaprika() {
      let market = await this.getCoinPaprikaTickers();
      if (market) {
        for (let i in market) {
          let ticker = market[i];
          if (coinpaprikaids[ticker.id]) {
            let currency = this.verus.currencies[coinpaprikaids[ticker.id]];
            if (currency) {
              this.verus.set_market_ticker(currency.currencyid, ticker);
            }
          }
        }
      } else {
        console.log("failed to get market data from coinpaprika for", name);
      }
    }
    
    async recacheTemplateVars() {
      let now = Date.now();
      
      let blockChanged = false;
      let info = await this.verus.getInfo(false);
      if (info) {
        if (this.lastBlock !== info.blocks) {
          this.lastBlock = info.blocks;
          blockChanged = true;
        }
      }
      
      if (this.templateCacheInterval < (now - this.lastTemplateCache) || blockChanged === true) {
        console.log("cache full update...", this.lastBlock);

        // only perform some things at timed intervals
        if (this.templateCacheInterval < (now - this.lastTemplateCache)) {
          await this.cacheCoinPaprika();
          await this.verus.cleanCache();
        }

        // keep template variables cache up to date
        await this.verus.getTemplateVars(false);

        this.lastTemplateCache = Date.now();

      } else {
        // keep checking critical cache items like opid/txid monitoring
        await this.verus.getTemplateVars(undefined);
      }

      // conversion monitoring
      await this.monitorConversions();
    }

    async runOnce() {
      // start      
      let start = Date.now();
      if (this.verbose > 0) {
        console.log(start, "VerusPROC.runOnce start");
      }
      
      this.executing = true;
      await this.recacheTemplateVars();
      for (let c in plugins) {
        await plugins[c].runOnce();
      }
      this.executing = false;
      
      let end = Date.now();
      if (this.verbose > 0) {
        console.log(end, "VerusPROC.runOnce took", (end - start), "ms");
      }
    }
    
    async run() {
      if (this.running) {
        await this.runOnce();
        if (this.running) {
          setTimeout(this.run.bind(this), this.interval);
        }
      }
    }
    
    async initPlugins() {
      let ploader = {};
      fs.readdirSync(PLUGINS_DIR).forEach(file => {
        if (file.endsWith(".js")) {
          let name = file.substring(0, file.indexOf('.'));
          try {
            ploader[name] = require(PLUGINS_DIR+"/"+file);
          } catch (e) {
            console.error("-------------------------------------\nFAILED to load plugin", file, "\n-------------------------------------\n", e, "\n\n-------------------------------------");
          }
        }
      });
      for (let c in ploader) {
        let p = ploader[c];
        plugins[c] = new p(this.verus, this.api, 1);
        await plugins[c].init();
      }
    }
    
    async start() {
      this.running = true;      
      setTimeout(this.run.bind(this), 1);
    }

    async stop() {
      this.running = false;
    }
}

module.exports = VerusPROC;