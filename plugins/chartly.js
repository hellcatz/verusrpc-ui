
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
    }
    
    name() {
      return "Chartly";
    }
    version() {
      return "0.0.1";
    }

    log(...args) {
      console.log(this.name(), ...args);
    }
    
    async renderMarketChart(req,res) {
      let basketid = req.params.basketid||"i3f7tSctFkiPpiedY8QR5Tep9p4qDVebDx";
      let currencyid = req.params.currencyid||"i5w5MuNik5NtLcYmNzcvaoixooEebB6MGV";
      let quoteid = req.params.quoteid||"iGBs4DWztRNvNEJBt4mqHszLxfKTNHTkhM";
      let data = await this.getApexChart(basketid, currencyid, quoteid);
      res.status(200).type('application/json').send(data);
    }

    async init() {

      this.api.get('/api/chart/latest/:basketid', async (req, res) => {
        if (this.markets[req.params.basketid]) {
          res.status(200).type('application/json').send(this.markets[req.params.basketid].slice(-10).reverse());
        } else {
          res.status(200).type('application/json').send([]);
        }
      });

      this.api.get('/api/chart/latest/transfers/:basketid/:limit', async (req, res) => {
        let limit = 10;
        try { limit = parseInt(req.params.limit); }
        catch { limit = 10; }
        let transfers = this.getLatestTransfers(req.params.basketid, limit);
        if (transfers) {
          res.status(200).type('application/json').send(transfers);
        } else {
          res.status(200).type('application/json').send([]);
        }
      });
      this.api.get('/api/chart/latest/transfers/:basketid', async (req, res) => {
        let transfers = this.getLatestTransfers(req.params.basketid);
        if (transfers) {
          res.status(200).type('application/json').send(transfers);
        } else {
          res.status(200).type('application/json').send([]);
        }
      });

      // setup api endpoint for chart data
      this.api.get('/api/chart/market/:basketid', async (req, res) => {
          this.renderMarketChart(req, res);
      });
      this.api.get('/api/chart/market/:basketid/:currencyid', async (req, res) => {
          this.renderMarketChart(req, res);
      });
      this.api.get('/api/chart/market/:basketid/:currencyid/:quoteid', async (req, res) => {
          this.renderMarketChart(req, res);
      });
      
      this.log(this.version(), "plugin initialized");
    }
    
    getLatestTransfers(currencyid, limit=10) {
        if (limit > 5000) { limit = 5000; }
        if (this.markets[currencyid]) {
          let transfers = [];
          let latest = this.markets[currencyid].slice(-100).reverse();
          for (let i in latest) {
            let item = latest[i];
            if (item.transfers && item.transfers.length > 0) {
              for (let z in item.transfers) {
                let transfer = item.transfers[z];
                transfer.blocktime = item.blocktime;
                transfer.blockstart = item.start;
                transfer.blockend = item.end;
                transfers.push(transfer);
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
    
    async getApexChart(basketid, currencyid, quoteid) {
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
      // start
      let start = Date.now();
      if (this.verbos > 0) {
        console.log("runOnce start");
      }

      this.executing = true;
      await this.doWork();
      this.executing = false;

      let end = Date.now();
      if (this.verbos > 0) {
        this.log("runOnce took", (end - start), "ms");
      }
    }

    async calculateMarketData(basketid, startBlock, endBlock, step=1, update_last_ohlc=false) {
      let ret = undefined;
      
      let totals = { ohlc: {}, volume: {} };
      let a = [];
      let b = [];

      // verus only outputs up to 20 results
      const maxreturn = 20;
      let range = (endBlock - startBlock);
      if (range > 20) {
        step = Math.round(range / maxreturn );
      }
      
      // get total volumes from the imports
      let v = await this.verus.getImports(basketid, startBlock, endBlock);
      if (v && Array.isArray(v)) {
        
        ret = {};

        // get the block time
        let block = await this.verus.request("getblock", [endBlock.toFixed()], true);
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
          let currencystate = state.importnotarization.currencystate;

          // keep transfer history
          if (state.transfers && state.transfers.length > 0) {
            for (let i in state.transfers) {
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

    async doWork() {
      // if we have blocks, calculate market data
      if (this.verus.info && this.verus.info.blocks && this.lastBlock != this.verus.info.blocks) {
        this.lastBlock = this.verus.info.blocks;

        // TODO, scan from list
        //  currently hardcoded to only scan Bridge.vETH

        const blocktime = 60;
        const blocksday = 1440;
        const scan_history_days = 60;
        const ticker_blocks = 60;
        const basketid = "i3f7tSctFkiPpiedY8QR5Tep9p4qDVebDx";
        
        // if we have cached the currency definition
        if (this.verus.currencies[basketid] && this.verus.currencies[basketid].startblock && this.verus.currencies[basketid].startblock < this.verus.info.blocks) {
          
          // gather from start block if needed
          if (!this.markets[basketid]) {
            this.markets[basketid] = [];

            this.lastTickerBlock = this.verus.currencies[basketid].startblock;
            if ((this.verus.info.blocks - this.lastTickerBlock) > 43200) {
              this.lastTickerBlock = (this.verus.info.blocks - 43200);
            }
            let gatherStart = Date.now();
            console.log("gathering market data for", basketid, "block", this.lastTickerBlock, "to", this.verus.info.blocks);
            while ((this.lastTickerBlock + ticker_blocks) < this.verus.info.blocks) {
              let p = await this.calculateMarketData(basketid, this.lastTickerBlock-ticker_blocks, this.lastTickerBlock, 1, true);
              if (p && p.blocktime && p.totals) {
                this.markets[basketid].push(p);
              }
              this.lastTickerBlock += ticker_blocks;
            }
            console.log("gathering took", Date.now() - gatherStart, "ms");
          }

          // gather "full" ticker stats if possible
          if ((this.verus.info.blocks - this.lastTickerBlock) >= ticker_blocks) {
            // remove partial ticker
            let last = this.markets[basketid].at(-1);
            if (last.start == this.lastTickerBlock) {
              console.log("removed partial ticker");
              this.markets[basketid].pop();
            }
            // get full ticker
            this.lastTickerBlock += ticker_blocks;
            console.log("calculating market data for", basketid, "block", this.lastTickerBlock, "to", this.verus.info.blocks);
            let p = await this.calculateMarketData(basketid, this.lastTickerBlock-ticker_blocks, this.lastTickerBlock, 1, true);
            if (p && p.blocktime && p.start && p.end && p.totals) {
              this.markets[basketid].push(p);
            }

          }

          // gather "partial" ticker stats
          if (this.lastTickerBlock < this.verus.info.blocks) {
            let start = this.lastTickerBlock;
            let end = this.verus.info.blocks;
            let p = await this.calculateMarketData(basketid, start, end, 1);
            if (p && p.blocktime && p.start && p.end) {
              // keep updating the last one
              let last = this.markets[basketid].at(-1);
              if (last.start == start) {
                console.log("update partial ticker", basketid, start, end);
                this.markets[basketid].pop();
                this.markets[basketid].push(p);
              } else {
                console.log("add partial ticker", basketid, start, end);
                this.markets[basketid].push(p);
              }
            }
          }

          // only keep 4 weeks of history
          let oldestblocktime = (Date.now()/1000) - 2.628e+6;
          while (this.markets[basketid][0].blocktime < oldestblocktime) {
            this.markets[basketid].shift();
          }

        }

      }
    }

}

module.exports = VerusProcPluginChartly;