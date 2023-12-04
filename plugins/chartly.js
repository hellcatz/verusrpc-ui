
const TYPE_DEST_PK = 1;
const TYPE_DEST_PKH = 2;
const TYPE_DEST_SH = 3;
const TYPE_DEST_ID = 4;
const TYPE_DEST_FULLID = 5;
const TYPE_DEST_REGISTERCURRENCY = 6;
const TYPE_DEST_QUANTUM = 7;
const TYPE_DEST_NESTEDTRANSFER = 8;
const TYPE_DEST_ETH = 9;
const TYPE_DEST_ETHNFT = 10;
const TYPE_DEST_RAW = 11;
const TYPE_FLAG_RESERVED1 = 16;
const TYPE_FLAG_RESERVED2 = 32;
const TYPE_FLAG_DEST_AUX = 64;
const TYPE_FLAG_DEST_GATEWAY = 128;

function hasFlag(integer, flag) {
  return (flag & integer) == flag;
}

class VerusProcPluginChartly {
    constructor(rpc, api, verbose=0) {      
        this.verus = rpc;
        this.api = api;
        this.verbose = verbose;

        this.executing = false;
        
        this.last_ohcl = {};
        this.markets = {};
        
        this.lastTickerBlock = 0;
        this.lastBlock = 0;
        
        this.lastTickerPartial = false;
        
        this.verus.chartly = this;
    }
    
    name() {
      return "Chartly";
    }
    version() {
      return "0.0.2";
    }

    log(...args) {
      console.log(this.name(), ...args);
    }
    
    async renderMarketChart(req,res) {
      let basketid = req.params.basketid||"i3f7tSctFkiPpiedY8QR5Tep9p4qDVebDx";
      let currencyid = req.params.currencyid||"i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV";
      let quoteid = req.params.quoteid||"iGBs4DWztRNvNEJBt4mqHszLxfKTNHTkhM";
      let data = await this.getMarketChart(basketid, currencyid, quoteid);
      res.status(200).type('application/json').send(data);
    }

    async renderTransfers(req,res) {
      const tvar = await this.verus.getTemplateVars(true);
      let address = undefined;
      if (req.params.address && req.params.address.trim().length > 0) {
        address = req.params.address;
      }
      let limit = 100;
      if (req.params.limit) {
        limit = req.params.limit;
      }
      const transfers = this.getLatestTransfers(req.params.basketid, address, limit);
      if (tvar != undefined) {
        res.render('viewtransfers', {
            title: 'Transfers',
            vars: tvar,
            transfers: transfers,
            basketid: req.params.basketid,
            address: address,
            limit: limit
        })
      } else {
          res.status(500).type('application/json').send({error: 500});
      }
    }

    async init() {
      // api into our cache
      this.api.get('/api/latest/:basketid', async (req, res) => {
        if (this.markets[req.params.basketid]) {
          res.status(200).type('application/json').send(this.markets[req.params.basketid].slice(-10).reverse());
        } else {
          res.status(200).type('application/json').send([]);
        }
      });
      this.api.get('/api/latest/transfers/:basketid', async (req, res) => {
        let transfers = this.getLatestTransfers(req.params.basketid);
        if (transfers) {
          res.status(200).type('application/json').send(transfers);
        } else {
          res.status(200).type('application/json').send([]);
        }
      });
      
      // api for ohlc chart data
      this.api.get('/api/chart/market/:basketid/:currencyid', async (req, res) => {
          this.renderMarketChart(req, res);
      });
      this.api.get('/api/chart/market/:basketid/:currencyid/:quoteid', async (req, res) => {
          this.renderMarketChart(req, res);
      });
      this.api.get('/api/chart/market/:basketid', async (req, res) => {
          this.renderMarketChart(req, res);
      });
      
      // render transfers pages
      this.api.get('/transfers/:basketid/:address/:limit', async (req, res) => {
        this.renderTransfers(req, res);
      }); 
      this.api.get('/transfers/:basketid/:address', async (req, res) => {
        this.renderTransfers(req, res);
      }); 
      this.api.get('/transfers/:basketid', async (req, res) => {
        this.renderTransfers(req, res);
      });
      
      // render market page
      this.api.get('/market/:basketid', async (req, res) => {
        this.renderMarketPage(req, res);
      });
      
      this.log(this.version(), "plugin initialized");
    }
    
    getLatestTransfers(currencyid, address=undefined, limit=10) {
      if (!limit) { limit = 10; }
      if (limit > 5000) { limit = 5000; }
      if (this.markets[currencyid]) {
        let transfers = [];
        let last = this.markets[currencyid].slice(-1)[0];
        if (last && last.pendingtransfers && last.pendingtransfers.length > 0) {
          let xfers = last.pendingtransfers.slice(-1000).reverse();
          for (let z in xfers) {
            let tx = xfers[z];            
            let transfer = tx.reservetransfer;
            let destination = transfer.destination.address;
            if (!address || destination === address) {
              transfer.txid = tx.txid;
              transfer.unconfirmed = true;
              transfers.push(transfer);
            }
          }
        }
        let latest = this.markets[currencyid].slice(-1000).reverse();
        for (let i in latest) {
          let item = latest[i];
          if (item.transfers && item.transfers.length > 0) {
            // *Note, there is a 500 transfer limit per tx
            let xfers = item.transfers.slice(-1000).reverse();
            for (let z in xfers) {
              let transfer = xfers[z];
              let destination = transfer.destination.address;
              if (!address || destination === address) {
                transfers.push(transfer);
              }
              if (transfers.length >= limit) {
                break;
              }
            }
          }
          if (transfers.length >= limit) {
            break;
          }
        }
        return transfers;
      }
      return undefined;
    }
    
    async getMarketChart(basketid, currencyid, quoteid) {
        let lastTime = 0;
        let ohlc = [];
        for(let i in this.markets[basketid]) {
          let s = this.markets[basketid][i];
          if (s.totals && s.totals.ohlc && s.totals.ohlc[currencyid] && s.totals.ohlc[currencyid][quoteid]) {
            // chart requirement, make sure time is always progressing forward, on blockchain they can go back'n'forth
            let fixedtime = s.blocktime;
            if (fixedtime <= lastTime) { fixedtime = (lastTime+1); }
            lastTime = fixedtime;
            ohlc.push({ 
              Date: fixedtime * 1000,
              Open: s.totals.ohlc[currencyid][quoteid].o,
              High: s.totals.ohlc[currencyid][quoteid].h,
              Low: s.totals.ohlc[currencyid][quoteid].l,
              Close: s.totals.ohlc[currencyid][quoteid].c,
              Volume: s.totals.volume[quoteid]||0 });
          }
        }
        return ohlc;
    }

    async runOnce() {
      if (this.executing !== true)
      {
        this.executing = true;
        
        // start
        let start = Date.now();
        if (this.verbos > 0) {
          this.log("runOnce start");
        }

        await this.doWork();
        
        let end = Date.now();
        if (this.verbos > 0) {
          this.log("runOnce took", (end - start), "ms");
        }
        
        this.executing = false;
      }
    }

    async calculateSlippageData(basketid) {
      if (this.verus.currencies[basketid]) {
        let c = this.verus.currencies[basketid];
        let slippage = {};
        let si = 1;
        
        if (this.markets[basketid]) {
          let imp = this.markets[basketid].slice(-1)[0].results.slice(-1)[0];
          let cstate = imp.importnotarization.currencystate;
          if (cstate && cstate.reservecurrencies) {
            while (si < 10) {              
               for (let i in cstate.reservecurrencies) {
                let base = cstate.reservecurrencies[i];
                let from = base.currencyid;
                for (let z in cstate.reservecurrencies) {
                  let quote = cstate.reservecurrencies[z];
                  let to = quote.currencyid;
                  let price = this.verus.getReserveCurrencyPrice(imp, quote.currencyid, base.currencyid)
                  let amount = price * si;
                  let estimate = await this.verus.estimateConversion(amount, from, to, basketid, false);
                  if (estimate) {
                    if (!slippage[from]) { slippage[from] = {} }
                    slippage[from][to] = (si - estimate.estimatedcurrencyout);
                    console.log(si, amount, this.verus.currencynames[from], estimate.estimatedcurrencyout, this.verus.currencynames[to]);
                  }
                }
              }
              //console.log(si, slippage);
              si += 1;
            }
          }
        }
      }
    }
    
    async calculateMarketDataFromCurrencyState(basketid, startBlock, endBlock, step=1, update_last_ohlc=false) {

      // extract martket data from import notarizations for most accurate
      let v = await this.verus.getCurrencyState(basketid, startBlock, endBlock);
      if (v && Array.isArray(v)) {
        //console.log(v);
        for (let i in v) {
          let c = v[i];
          //c.height;
          //c.blocktime;
          
        }
      }     
    }

    findReserveOutput(transfer, vout, index=0) {
      let last = undefined;
      let n = 0;
      let destinationcurrencyid = transfer.destinationcurrencyid;
      let destination = transfer.destination.address;
      for (let i in vout) {
        let o = vout[i];
        if (o.scriptPubKey.reserveoutput) {
          if ( o.scriptPubKey.reserveoutput.currencyvalues[destinationcurrencyid] &&
               o.scriptPubKey.addresses.indexOf(destination) > -1
             ) {
              if (index === n) {
                return o;
              }
          }
          n++;
        }
        else if (o.scriptPubKey.reservetransfer && o.scriptPubKey.reservetransfer.crosssystem === true) {
          if (o.scriptPubKey.reservetransfer.destinationcurrencyid === destinationcurrencyid &&
              o.scriptPubKey.reservetransfer.destination.address === destination
             ) {
               if (index === n) {
                  return o;
               }
          }
          n++;
        }
        else if (o.valueSat > 0) {
          if (o.scriptPubKey.addresses.indexOf(destination) > -1 &&
                 destinationcurrencyid === this.verus.nativecurrencyid
                ) {
                  if (index === n) {
                    return o;
                  }
          }
          n++;
        }
      }
      //console.log("output not found for", transfer);
      return last;
    }

    async calculateMarketData(basketid, startBlock, endBlock, step=1, update_last_ohlc=false) {
      let ret = undefined;
      
      let totals = { ohlc: {}, volume: {} };
      let a = [];
      let b = [];
      
      // extract martket data from import notarizations
      let v = await this.verus.getImports(basketid, startBlock, endBlock);
      if (v && Array.isArray(v)) {
        
        ret = {};

        // get the block time
        let block = await this.verus.request("getblock", [startBlock.toFixed()], true);
        if (block && !block.error) {
          let time = ((block.result.time||(Date.now()/1000)));
          if (time && time > 0) {
            ret.blocktime = time;
          }
        }

        ret.start = startBlock;
        ret.end = endBlock;

        if (!totals.ohlc[basketid]) { totals.ohlc[basketid] = {}; }
        if (!this.last_ohcl[basketid]) { this.last_ohcl[basketid] = {}; }
        
        for (let i in v) {
          let state = v[i];
        
          let block = await this.verus.request("getblock", [state.importheight.toFixed()], true);
          if (block && !block.error) {
            let time = ((block.result.time||(Date.now()/1000)));
            if (time && time > 0) {
              state.blocktime = time;
            }
          }
          
          let currencystate = state.importnotarization.currencystate;
          
          // get transaction for amounts received
          let tx = await this.verus.getRawTransaction(state.importtxid, true, false);

          // keep transfer history
          if (state.transfers && state.transfers.length > 0) {
            for (let i in state.transfers) {
              // only show reserve transfers
              state.transfers[i].txid = state.importtxid;
              state.transfers[i].time = new Date(state.blocktime*1000).toISOString();
              
              // find the reserveoutput for this transfer
              let output = this.findReserveOutput(state.transfers[i], tx.vout, parseInt(i));
              if (output) {
                // remove extra data
                if (output.scriptPubKey) {
                  output.scriptPubKey.hex = undefined;
                  output.scriptPubKey.asm = undefined;
                }
                state.transfers[i].output = output;
              }
              
              // TODO, decode flags and type for more detailed info about the transaction conversion,export,etc.
              if (hasFlag(state.transfers[i].destination.type, TYPE_DEST_ETH)) {
                state.transfers[i].destination.exportETH = true;
              } else if (hasFlag(state.transfers[i].destination.type, TYPE_DEST_ETHNFT)) {
                state.transfers[i].destination.exportETH = true;
              } else if  (hasFlag(state.transfers[i].destination.type, TYPE_FLAG_DEST_GATEWAY)) {
                console.log("FLAG_DEST_GATEWAY", state.transfers[i].destination);
              }
              
              b.push(state.transfers[i]);
            }
          }

          ret.supply = currencystate.supply;
          
          if (!currencystate.liquidity) { currencystate.liquidity = {}; }
          
          // alse parse from getcurrencystate 
          for (let i in currencystate.reservecurrencies) {
            let c = currencystate.reservecurrencies[i];

            if (!totals.ohlc[c.currencyid]) { totals.ohlc[c.currencyid] = {}; }
            if (!this.last_ohcl[c.currencyid]) { this.last_ohcl[c.currencyid] = {}; }

            // track price in currency
            let priceincurrency = 1 / c.priceinreserve;
            if (!totals.ohlc[c.currencyid][basketid]) {
              totals.ohlc[c.currencyid][basketid] = {
                o: this.last_ohcl[c.currencyid][basketid]?this.last_ohcl[c.currencyid][basketid].c:priceincurrency,
                h: priceincurrency,
                l: priceincurrency,
                c: priceincurrency
              };
            }
            if (!this.last_ohcl[c.currencyid][basketid]) { this.last_ohcl[c.currencyid][basketid] = totals.ohlc[c.currencyid][basketid]; }
            totals.ohlc[c.currencyid][basketid].c = priceincurrency;
            totals.ohlc[c.currencyid][basketid].h = priceincurrency>totals.ohlc[c.currencyid][basketid].h?priceincurrency:totals.ohlc[c.currencyid][basketid].h;
            totals.ohlc[c.currencyid][basketid].l = priceincurrency<totals.ohlc[c.currencyid][basketid].l?priceincurrency:totals.ohlc[c.currencyid][basketid].l;
            if (update_last_ohlc === true) {
              this.last_ohcl[c.currencyid][basketid] = totals.ohlc[c.currencyid][basketid];
            }

            // track price in reserve
            if (!totals.ohlc[basketid][c.currencyid]) {
              totals.ohlc[basketid][c.currencyid] = {
                o: this.last_ohcl[basketid][c.currencyid]?this.last_ohcl[basketid][c.currencyid].c:c.priceinreserve,
                h: c.priceinreserve,
                l: c.priceinreserve,
                c: c.priceinreserve
              };
            }
            if (!this.last_ohcl[basketid][c.currencyid]) { this.last_ohcl[basketid][c.currencyid] = totals.ohlc[basketid][c.currencyid]; }
            totals.ohlc[basketid][c.currencyid].c = c.priceinreserve;
            totals.ohlc[basketid][c.currencyid].h = c.priceinreserve>totals.ohlc[basketid][c.currencyid].h?c.priceinreserve:totals.ohlc[basketid][c.currencyid].h;
            totals.ohlc[basketid][c.currencyid].l = c.priceinreserve<totals.ohlc[basketid][c.currencyid].l?c.priceinreserve:totals.ohlc[basketid][c.currencyid].l;
            if (update_last_ohlc === true) {
              this.last_ohcl[basketid][c.currencyid] = totals.ohlc[basketid][c.currencyid];
            }

            // track liquidity
            let liquidity = (currencystate.supply * c.priceinreserve);
            currencystate.liquidity[c.currencyid] = liquidity;
            ret.liquidity = currencystate.liquidity;

            // track price of each reserve current relate to each other
            for (let z in currencystate.reservecurrencies) {
              let cc = currencystate.reservecurrencies[z];

              let price = this.verus.getReserveCurrencyPrice(state, cc.currencyid, c.currencyid);
              if (price > -1 && Number.isFinite(price)) {
                if (!currencystate.currencies[cc.currencyid].prices) { currencystate.currencies[cc.currencyid].prices = {}; }
                currencystate.currencies[cc.currencyid].prices[c.currencyid] = price;

                // track ohlc market data
                if (!totals.ohlc[cc.currencyid]) { totals.ohlc[cc.currencyid] = {}; }
                if (cc.currencyid !== c.currencyid) {
                  if (!this.last_ohcl[cc.currencyid]) { this.last_ohcl[cc.currencyid] = {}; }
                  if (!totals.ohlc[cc.currencyid][c.currencyid]) {
                    totals.ohlc[cc.currencyid][c.currencyid] = {
                      o: this.last_ohcl[cc.currencyid][c.currencyid]?this.last_ohcl[cc.currencyid][c.currencyid].c:price,
                      h: price,
                      l: price,
                      c: price
                    };
                  }
                  if (!this.last_ohcl[cc.currencyid][c.currencyid]) { this.last_ohcl[cc.currencyid][c.currencyid] = totals.ohlc[cc.currencyid][c.currencyid]; }
                  totals.ohlc[cc.currencyid][c.currencyid].c = price;
                  totals.ohlc[cc.currencyid][c.currencyid].h = price>totals.ohlc[cc.currencyid][c.currencyid].h?price:totals.ohlc[cc.currencyid][c.currencyid].h;
                  totals.ohlc[cc.currencyid][c.currencyid].l = price<totals.ohlc[cc.currencyid][c.currencyid].l?price:totals.ohlc[cc.currencyid][c.currencyid].l;
                  if (update_last_ohlc === true) {
                    this.last_ohcl[cc.currencyid][c.currencyid] = totals.ohlc[cc.currencyid][c.currencyid];
                  }
                }
              }
            }
          }

          // get volumes priced in each reserve
          for (let currencyid in currencystate.currencies) {
            let c = currencystate.currencies[currencyid];
            
            if (!totals.volume[basketid]) { totals.volume[basketid] = 0; }
            totals.volume[basketid] += (c.reservein * (1 / c.lastconversionprice));
                        
            if (!totals.volume[currencyid]) { totals.volume[currencyid] = 0; }
            for (let baseid in currencystate.currencies) {
              let cc = currencystate.currencies[baseid];
              let price = this.verus.getReserveCurrencyPrice(state, baseid, currencyid);
              if (price && price > 0) {
                totals.volume[currencyid] += (cc.reservein * price);
              }
            }
          }

          a.push(state);

        }

        ret.totals = totals;
        ret.results = a;
        ret.transfers = b; 
      }

      return ret;
    }
    
    async gatherPendingTransfers(basketid, last) {
      let p = await this.verus.getPendingTransfers(basketid);
      if (p && Array.isArray(p)) {
        last.pendingtransfers = p;
      }
    }

    async doWork() {
      // if we have blocks, calculate market data
      if (this.verus.info && this.verus.info.blocks) {

        // TODO, scan from list
        //  currently hardcoded to only scan Bridge.vETH        
        const basketid = "i3f7tSctFkiPpiedY8QR5Tep9p4qDVebDx";
        
        // if new block ...
        if (this.lastBlock != this.verus.info.blocks) {
          this.lastBlock = this.verus.info.blocks;

          const maxhistory = 43200;
          const blocktime = 60;
          const blocksday = 1440;
          const ticker_blocks = 20;

          // if we have cached the currency definition
          if (this.verus.currencies[basketid] && this.verus.currencies[basketid].startblock && this.verus.currencies[basketid].startblock < this.verus.info.blocks) {
            
            // gather from start block if needed
            if (!this.markets[basketid]) {
              this.markets[basketid] = [];

              let start = this.verus.currencies[basketid].startblock;
              let end = this.verus.info.blocks;
              if ((end - start) > maxhistory) {
                start = (end - maxhistory);
              }
              
              let gatherStart = Date.now();
              console.log("gathering market data for", basketid, "block", start, "to", this.verus.info.blocks);
              // gather full tickers
              while ((start + ticker_blocks) < end) {
                let p = await this.calculateMarketData(basketid, start, (start+ticker_blocks), 1, true);
                if (p && p.blocktime && p.start && p.end) {
                  this.markets[basketid].push(p);
                }
                start += (ticker_blocks + 1);
              }
              // last full ticker end position
              this.lastTickerBlock = start;
              console.log("gathering took", Date.now() - gatherStart, "ms, ended at block", this.lastTickerBlock);
            }

            // gather ticker stats on-the-fly
            if (this.lastTickerBlock < this.verus.info.blocks) {
              let start = this.lastTickerBlock;
              let end = this.verus.info.blocks;
              let last = this.markets[basketid].at(-1);
              let newTicker = ((end - start) >= ticker_blocks);
              
              //let tmp = await this.calculateMarketDataFromCurrencyState(basketid, start, end, 1, newTicker);
              
              let p = await this.calculateMarketData(basketid, start, end, 1, newTicker);
              if (p && p.blocktime && p.start && p.end) {
                // if this is the end of currenct ticker
                if (newTicker) {
                  this.lastTickerBlock = end + 1;
                  if (this.lastTickerPartial === true) {
                    this.markets[basketid].pop();   // remove previous partial
                  }
                  this.markets[basketid].push(p);
                  console.log("ticker complete", basketid, start, end);
                  
                } else if (last.start == start) {
                  // existing partial
                  await this.gatherPendingTransfers(basketid, p);
                  this.markets[basketid].pop();   // remove previous partial
                  this.markets[basketid].push(p); // push updated partial
                  this.lastTickerPartial = true;
                  console.log("updated partial ticker", basketid, start, end, "ticker blocks remaining", ticker_blocks - (end-start));

                } else {
                  // new partial ticker
                  this.markets[basketid].push(p);
                  this.lastTickerPartial = true;
                  console.log("new partial ticker", basketid, start, end, "ticker blocks remaining", ticker_blocks - (end-start));
                }

              } else {
                if (newTicker) {
                  this.lastTickerBlock = end + 1;
                  console.log("ticker complete with no transfers", basketid, start, end);
                }
              }
            }

            // only keep 4 weeks of history
            let oldestblocktime = (Date.now()/1000) - 2.628e+6;
            while (this.markets[basketid][0].blocktime < oldestblocktime) {
              this.markets[basketid].shift();
            }
            
            //let slippage_data = await this.calculateSlippageData(basketid);
            
          }

        } else {
          // no new blocks check pendingtransfers
          let last = this.markets[basketid].at(-1);
          await this.gatherPendingTransfers(basketid, last);
        }
      }
    }

}

module.exports = VerusProcPluginChartly;