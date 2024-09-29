const fs = require('fs');

const crypto = require('node:crypto');
const { isAddress } = require('web3-validator');

const axios = require('axios');

const RPC_CACHE_TIMEOUT = 300000; // 5 minute rpc cache...


const OPT_IS_TOKEN = 0x20;
const OPT_IS_FRACTIONAL = 0x01;
const OPT_IS_PBAAS = 0x100;
const OPT_IS_GATEWAY = 0x80;
const OPT_IS_GATEWAY_CONVERTER = 0x200;
const OPT_IS_NFT_TOKEN = 0x800;

const FLAG_DEFINITION_NOTARIZATION = 0x01;
const FLAG_PRE_LAUNCH = 0x02;
const FLAG_START_NOTARIZATION = 0x04;
const FLAG_LAUNCH_CONFIRMED = 0x08;
const FLAG_REFUNDING = 0x10;
const FLAG_ACCEPTED_MIRROR = 0x20;
const FLAG_BLOCKONE_NOTARIZATION = 0x40;
const FLAG_SAME_CHAIN = 0x80;
const FLAG_LAUNCH_COMPLETE = 0x100;
const FLAG_CONTRACT_UPGRADE = 0x200;


function checkCurrencyOption(integer, flag) {
  return (flag & integer) == flag;
}
function checkFlag(integer, flag) {
  return (flag & integer) == flag;
}

const explorers = require("./explorers.json");

var currentBlockHeight = 0;

class VerusRPC {
    constructor(url, user, pass, verbose=0) {
        this.url = url;
        this.user = user;
        this.pass = pass;
        this.verbose = verbose;
        this.minconf = 1;
        
        this.curid = 0;
        
        this.nativecurrencyid = undefined;
        this.nativename = undefined;
        
        this.opids = [];
        this.ops = {};
        this.txids = [];
        this.txs = {};
        this.addresses = {};
        this.balances = {};
        this.info = {};
        this.nextblockreward = {};
        this.mininginfo = {};
        this.currencies = {};
        this.tickers = {};
        this.conversions = [];

        // id to name translation table
        this.currencyids = {};
        // name to id translation table
        this.currencynames = {};
    }

    async init() {
      this.createCache();
      // restore saved conversions from disk
      if (fs.existsSync("conversions.json")) {
        let data = fs.readFileSync("conversions.json");
        let json = undefined;
        try { json = JSON.parse(data); }
        catch { json = undefined; }
        if (json) {
          this.conversions = json;
        }
      }
    }

    createCache() {
      this.rpccache = {};
    }
    cleanCache() {
      let now = Date.now();
      let toRemove = [];
      for (let k in this.rpccache) {
        let item = this.rpccache[k];
        if ((now - item.timestamp) > RPC_CACHE_TIMEOUT) {
          toRemove.push(k);
        }
      }
      for (let i in toRemove) {
        let k = toRemove[i];
        this.rpccache[k] = undefined;
        delete this.rpccache[k];
      }
    }
    updateCache(method, params, response) {
      let uid = method + JSON.stringify(params);
      let hash = crypto.createHash('sha256').update(uid).digest("hex");
      let r = this.rpccache[hash]?1:0; // 1 = updated, 0 = added
      this.rpccache[hash] = {};
      this.rpccache[hash].response = response;
      this.rpccache[hash].timestamp = Date.now();
      return r;
    }
    getCache(method, params) {
      let uid = method + JSON.stringify(params);
      let hash = crypto.createHash('sha256').update(uid).digest("hex");
      if (this.rpccache[hash]) {
        return this.rpccache[hash];
      }
      return undefined;
    }
    
    // *Note, just in case we need to format something when building rpc request to daemon
    jsonReplacer(key, value) {
      // force 8 decimal precision for "amount" fields (string is ok to send to daemon)
      if (key == "amount" && typeof value === 'number'){
        return value.toFixed(8);
      }
      return value;
    }
    
    set_market_ticker(currencyid, ticker) {
      if (this.currencies[currencyid]) {
        this.tickers[currencyid] = ticker;
        this.tickers[currencyid].last_udpated = Date.now();
        this.currencies[currencyid].coinpaprika = this.tickers[currencyid];
      }
    }
    
    get_closest(numbers, number) {
      let closest = numbers.reduce(function(prev, curr) {
        return (Math.abs(curr - number) < Math.abs(prev - number) ? curr : prev);
      });
      return closest;
    }
    
    add_opid(op) {
      let opid = op.id;
      if (opid) {
        if (!this.ops[op.id]) {
          this.ops[op.id] = op
          this.opids.push(op.id);
          console.log("added opid", op.id, "to monitor");
          return true;
        } else {
          if (this.ops[op.id].status != op.status) {
            this.ops[op.id] = op;
            console.log("updated opid", op.id);
            return true;
          }
        }
      }
      return false;
    }
    remove_opid(op) {
      let opid = op.id;
      const index = this.opids.indexOf(opid);
      if (index > -1) {
        this.opids.splice(index, 1);
      }
      if (this.ops[opid]) {
        console.log("remove opid", opid, "from monitor");
        delete this.ops[opid];
      }
    }

    add_txid(txid) {
      if (this.txids.indexOf(txid) < 0) {
        this.txids.push(txid);
        console.log("new txid", txid);
        return true;
      }
      return false;
    }
    remove_txid(txid) {
      const index = this.txids.indexOf(txid);
      if (index > -1) {
        this.txids.splice(index, 1);
      }
      if (this.txs[txid]) {
        console.log("remove txid", txid, "from monitor");
        delete this.txs[txid];
      }
    }
    async add_conversion(txid, currency, convertto, via, amount, destaddr, n, now) {
      let sid = txid+currency+convertto+via+amount;
      let uid = crypto.createHash('sha256').update(sid).digest().toString('hex');
      let c = {
        uid: uid,
        txid: txid,
        status:"pending",
        amount: amount,
        currency: currency,
        convertto: convertto,
        via: via,
        destination: destaddr,
        started: now,
        n: n
      };
      for (let i in this.conversions){
        let conv = this.conversions[i];
        if (conv.txid == c.txid &&
            conv.currency == c.currency &&
            conv.convertto == c.convertto &&
            conv.destination == c.destination) {
            return false;
        }
      }
      // get the estimate now
      let e = await this.estimateConversion(amount, currency, convertto, via, false, false);
      if (e) {
        c.estimate = e.estimatedcurrencyout;
      } else {
        console.error("failed to get estimate for conversion");
      }
      this.conversions.push(c);
      console.log("new conversion", txid, c);
      // dump conversions to file as backup in case of restart
      fs.writeFileSync("conversions.json", JSON.stringify(this.conversions), {encoding:'utf8',flag:'w'});
      return true;
    }
    remove_conversion(uid) {
      let f = false;
      let i = 0;
      while (i < this.conversions.length) {
        let c = this.conversions[i];
        if (c.uid == uid) {
          this.conversions.splice(i, 1);
          f = true;
        } else {
          ++i;
        }
      }
      return f;
    }
    remove_conversion_by_details(txid, amount, currency, convertto, destination) {
      let f = false;
      let i = 0;
      while (i < this.conversions.length) {
        let c = this.conversions[i];
        if (c.txid == txid &&
            c.amount == amount &&
            c.currency == currency &&
            c.convertto == convertto &&
            c.destination == destination) {
            this.conversions.splice(i, 1);
            f = true;
        } else {
          ++i;
        }
      }
      return f;
    }
    remove_conversion_by_txid(txid) {
      let f = false;
      let i = 0;
      while (i < this.conversions.length) {
        let c = this.conversions[i];
        if (c.txid == txid) {
          this.conversions.splice(i, 1);
          f = true;
        } else {
          ++i;
        }
      }
      return f;
    }
    remove_conversion_by_success() {
      let f = false;
      let i = 0;
      while (i < this.conversions.length) {
        let c = this.conversions[i];
        if (c.status == "success") {
          this.conversions.splice(i, 1);
          f = true;
        } else {
          ++i;
        }
      }
      return f;
    }
    get_conversions() {
      return this.conversions;
    }
    get_conversion_by_uid(uid) {
      for (let i in this.conversions) {
        let c = this.conversions[i];
        if (c.uid == uid) {
          return c;
        }
      }
      return undefined;
    }
    get_conversion_by_details(currency, convertto, destination, amount, slippage=0.0) {
      let matches = [];
      let cid = (currency.startsWith("i") && currency.length===34)?currency:this.currencyids[currency];
      let ctid = (convertto.startsWith("i") && currency.length===34)?convertto:this.currencyids[convertto];
      for (let i in this.conversions) {
        let c = this.conversions[i];
        let pAmount = c.received || c.estimate;
        let gainloss = ((pAmount - amount) / amount) * 100.0;        
        if ((c.received === amount || (Math.abs(gainloss) < slippage)) &&
            c.currency === currency &&
            c.convertto === convertto &&
            c.destination === destination) {
            matches.push(c);
        }
      }
      return matches;
    }
    get_conversion_by_txid(txid) {
      let matches = [];
      for (let i in this.conversions) {
        let c = this.conversions[i];
        if (c.txid == txid) {
          matches.push(c);
        }
        if (c.spentTxId == txid) {
          matches.push(c);
        }
        if (c.spentTxId2 == txid) {
          matches.push(c);
        }
      }
      return matches;
    }

    // method = string
    // params = array
    async request(method, params=[], useCache=undefined) {
        let result = undefined;

        // check cache first
        let orig_start = Date.now();
        let start = orig_start;
        let end = orig_start;
        let cache = this.getCache(method, params);
        if (cache && useCache !== false) {
          if (useCache === true || (start - cache.timestamp) < RPC_CACHE_TIMEOUT) {
            return { result: cache.response, error:undefined };
          }
        }
        let data = JSON.stringify({
            jsonrpc: "1.0",
            id: this.curid,
            params: params,
            method: method
        }, this.jsonReplacer);

        this.curid = (this.curid + 1) & 0xff;

        start = Date.now();
        const rsp = await axios.post(this.url, data, {
            auth: {
                username: this.user,
                password: this.pass
            },
            headers: {                
                'Content-Type': 'application/json;charset=utf-8',
                'Content-Length': Buffer.byteLength(data, 'utf8'),
                'Connection': 'close'
            }
        }).catch(function (error) {
            if (error.response) {
              // The request was made and the server responded with a status code
              // that falls out of the range of 2xx
              //console.log(error.response.headers);
              if (error.response.data.error) {
                  result = {result: undefined, error: error.response.data.error};
              } else if (error.response.statusText) {
                  result = {result: undefined, error: {message: error.response.statusText}};
              } else if (error.response.status) {
                  result = {result: undefined, error: {message: error.response.status}};
              } else {
                result = {result: undefined, error: "unknown response error"};
                console.log("RSP ERROR:", error.response);
              }
            } else if (error.request) {
              result = {result: "", error: {message: "connection rejected or timeout"}};
            } else {
              result = {result: "", error: {message: "unknown error"}};
              console.log("AXIOS ERROR:", error);
            }
            
        }).then(function (response) {
            if (response) {
                if (response.data) {
                  if (!response.data.error && response.data.result) {
                      result = {result: response.data.result, error: undefined};
                      
                  } else if (response.data.error) {
                      result = {result: undefined, error: response.data.error};
                  } else {
                      result = {result: "", error: undefined};
                  }
                } else {
                  console.log(response);
                }
            } else if (!result) {
              result = {result: "", error: undefined};
            }
        });
        
        await rsp;

        end = Date.now();
        let rpcTotalMs = end - start;
        if (result && result.result !== undefined) {
          this.updateCache(method, params, result.result);
        }
        end = Date.now();
        let total_time = (end - orig_start);
        if (this.verbose > 1) {
          console.log("RPC `"+data+"` took", total_time +"ms; rpc took", rpcTotalMs + "ms");
        } else if (this.verbose > 0 || rpcTotalMs > 5000) {
          console.log("RPC `"+method+"` took", total_time +"ms; rpc took", rpcTotalMs + "ms");
        }

        return result;
    }
    
    async isOnline() {
      let rsp = await this.request("getinfo", [], false);
      let r = { online: (rsp && !rsp.error)};
      if (r.online) {
        if (rsp.result.chainid && rsp.result.name) {
          let ncurrency = await this.getCurrency(rsp.result.name, false);
          if (ncurrency) {
            this.nativecurrencyid = rsp.result.chainid;
            this.nativename = rsp.result.name;
            console.log("Detected native chain", {chainid: this.nativecurrencyid, name: this.nativename});
          } else {
            console.error("Failed to fetch native currency details from daemon");
          }
        }
        r.VRSCversion = rsp.result.VRSCversion;
        r.blocks = rsp.result.blocks;
        r.longestchain = rsp.result.longestchain;
      } else if (rsp.error) {
        r.error = rsp.error;
      } else {
        r.error = rsp;
      }
      return r;
    }
    
    async isValidAddress(address) {
      // quick sanity check
      if (!address || typeof address != "string" || address.length < 2) return false;

      let rpcMethod = "validateaddress";
      if (address.startsWith("zs1")) {
        rpcMethod = "z_validateaddress";
      }
      if (address.endsWith("@")) {
        rpcMethod = "getidentity";
      }
      if (address.startsWith("0x")) {
        return isAddress(address) === true;
      }
      let rsp = await this.request(rpcMethod, [address], false);
      if ((rsp && !rsp.error)) {
          if (rsp.result.identity && rsp.result.identity.name) {
            return address.toLowerCase().startsWith(rsp.result.identity.name.toLowerCase());
          }
          return (rsp.result.isvalid === true);
      } else if (!rsp.error) {
        console.error(rsp);
      }
      return false;
    }

    async waitForOnline() {
      const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
      let r = await this.isOnline();
      while (!r.online) {
          if (r.error && r.error.code == -28) {
            console.log("waiting 5 second, verusd startup:", r.error);
            await delay(5000) /// waiting 5 second. 
          } else {
            console.log("waiting 15 seconds, verusd offline:", r.error);
            await delay(15000) /// waiting 15 second. 
          }
          r = await this.isOnline();
      }
      return r;
    }
    
    async getTemplateVars(useCache=undefined) {

      const opids = await this.listOperationIDs(true);
      const txids = await this.monitorTransactionIDs(true);
      const opid_counts = {};
      const keys = Object.keys(opids);

      const baskets = await this.getBaskets();

      for (let key in keys) {
        opid_counts[keys[key]] = Object.keys(opids[keys[key]]).length;
      }

      return {
        coin: this.nativecurrencyid,
        coins: this.balances.currencynames?Object.keys(this.balances.currencynames):[],
        
        addresses: this.addresses,
        balances: this.balances,
        
        currencyids: this.currencyids,
        currencynames: this.currencynames,
        
        baskets: baskets,
        
        currencies: this.currencies,
        conversions: this.conversions,
        
        txid_count: this.txids.length,
        txids: txids,
        
        opid_count: this.opids.length,
        opid_counts: opid_counts,
        opids: opids,
        
        info: this.info,
        nextblockreward: this.nextblockreward,
        mininginfo: this.mininginfo,
        tickers: this.tickers,
        explorers: explorers
      };
    }

    async monitorTransactionIDs(useCache=undefined) {
      for (let i in this.txids) {
        let r = await this.getRawTransaction(this.txids[i], (useCache===true?true:false), true);
        if (!r || r.error) {
          console.error("failed to get transaction details for", this.txids[i]);
        }
      }
      // return full tx details
      let r = {};
      for (let tx in this.txs) {
        r[this.txs[tx].txid] = this.txs[tx];
      }
      return r;
    }
    
    isMyAddress(address) {
      for (let o in this.addresses) {
        for (let a in this.addresses[o]) {
          if (this.addresses[o][a] === address) {
            return true;
          }
        }
      }      
      return false;
    }
    
    async getRawTransaction(txid, useCache=undefined, monitoringTx=false) {
      let tx = undefined;
      let rsp = await this.request("getrawtransaction", [txid, 1], useCache);
      if (rsp && !rsp.error) {
        tx = rsp.result;
        if (tx && tx.txid == txid) {
          if (useCache === false) {
            // monitoring ?
            if (monitoringTx === true) {
              if (!this.txs[tx.txid]) {
                this.txs[tx.txid] = tx;
                console.log("add txid", tx.txid, "to monitor");
              } else if (tx.height && !this.txs[tx.txid].height) {
                this.txs[tx.txid] = tx;
                console.log("txid", tx.txid, "included in block", tx.height);
              } else if (tx.confirmations && tx.confirmations >= this.minconf) {
                console.log("txid", tx.txid, "confirmed");
                this.remove_txid(tx.txid);
              } else if (tx.confirmations && tx.confirmations != this.txs[tx.txid].confirmations) {
                this.txs[tx.txid] = tx;
                if (tx.confirmations < 0) {
                  console.log("txid", tx.txid, "orphaned", tx.confirmations, "of", this.minconf, "confirmations...");
                } else {
                  console.log("txid", tx.txid, "pending", tx.confirmations, "of", this.minconf, "confirmations...");
                }
              } else if (tx.expiryheight && !tx.height && !tx.confirmations) {
                if (tx.expiryheight > currentBlockHeight) {
                  if (this.txs[tx.txid].expiresin != (tx.expiryheight - currentBlockHeight)) {
                    console.log("txid", tx.txid, "expires in", (tx.expiryheight - currentBlockHeight), "blocks");
                  }
                } else {
                  console.log("txid", tx.txid, "expired", (currentBlockHeight - tx.expiryheight), "blocks ago");
                }
              } else if (!tx.height && !tx.confirmations) {
                console.log("unknown state for txid", tx.txid, tx);
              }
            }

            // detect conversions that we need to monitor
            if (tx.vout && Array.isArray(tx.vout)) {
              let cmatches = this.get_conversion_by_txid(txid);
              
              let used_vout_n = [];
              let vout_amounts = [];
              let conversions_success = [];

              // parse outputs in transaction for conversion progress
              let now = Date.now();
              for (let i in tx.vout) {
                let amount = 0;
                let o = tx.vout[i];
                let n = tx.vout[i].n;
                if (o.scriptPubKey) {
                  let s = o.scriptPubKey;
                  // detect conversion starts
                  if (s.reservetransfer) {
                    let convert = s.reservetransfer.convert === true;
                    let r2r = s.reservetransfer.reservetoreserve === true;
                    let valuesbyid = s.reservetransfer.currencyvalues;
                    let fees = s.reservetransfer.fees;
                    let fcurrencyid = s.reservetransfer.feecurrencyid
                    let destcurrencyid = s.reservetransfer.destinationcurrencyid;
                    let via = s.reservetransfer.via;
                    let destination = s.reservetransfer.destination.address;
                    let isMine = this.isMyAddress(destination);
                    if (convert & isMine) {
                      let currencyid = undefined;
                      let amount = undefined;
                      for (let i in valuesbyid) {
                        currencyid = i;
                        amount = valuesbyid[i];
                        //console.log(fees);
                        // add conversion
                        this.add_conversion(txid, currencyid, destcurrencyid, via, amount, destination, n, now);
                        // update spentTxId for active conversions
                        if (o.spentTxId) {
                          for(let i in cmatches) {
                            let conversion = cmatches[i];
                            let cid = this.getCurrencyIdFromName(conversion.convertto);
                            if (cid && cid === destcurrencyid && conversion.spentTxId != o.spentTxId) {
                              console.log("conversion forward progress", o.spentTxId);
                              conversion.spentTxId = o.spentTxId; // monitor for finalizeexport spentTxId
                              conversion.spentTxId2 = undefined;  // force a new lookup
                            }
                          }
                        }
                        now++;
                      }
                    }

                  } else {

                    // check for progress on existing conversions
                    for(let i in cmatches) {
                      let conversion = cmatches[i];
                      if (o.scriptPubKey) {
                        let isMine = false;
                        for (let i in s.addresses) {
                          if (conversion.destination == s.addresses[i]) {
                            isMine = true;
                          }
                        }

                        if (isMine) {
                          // get all our 'n' amounts in outputs
                          if (s.reserveoutput && s.reserveoutput.currencyvalues && txid != conversion.txid && conversion.spentTxId && conversion.spentTxId2) {
                            // make sure the conversion is for the currency
                            let id = Object.keys(s.reserveoutput.currencyvalues)[0];
                            let cid = this.getCurrencyIdFromName(id);
                            // match by name or by id
                            if (id == conversion.convertto || cid === conversion.convertto) {
                              amount = s.reserveoutput.currencyvalues[Object.keys(s.reserveoutput.currencyvalues)[0]];
                              if (conversion.status === "pending") {
                                conversion.status = "complete";
                                conversion.received = amount;
                                console.log("matched received n", n, conversion.n)
                              }
                            }
                          } else if (o.value && o.value > 0.0 && txid != conversion.txid && conversion.spentTxId && conversion.spentTxId2) {
                            // make sure the conversion is for the native coin
                            let id = conversion.convertto;
                            let cid = this.getCurrencyIdFromName(id);
                            if (cid && cid === this.nativecurrencyid) { 
                              amount = o.value;
                              if (conversion.status === "pending") {
                                conversion.status = "complete";
                                conversion.received = amount;
                                console.log("matched received n", n, conversion.n)
                              }
                            }
                          }
                        }
                      }

                      if (conversion.status  === "pending" && s.finalizeexport && o.spentTxId) {
                        console.log("conversion waiting for finalizeexport in", o.spentTxId);
                        conversion.spentTxId2 = o.spentTxId;
                      }
                    }
                    
                  }
                }

                vout_amounts.push(amount);
              }
              
              for(let i in cmatches) {
                let conversion = cmatches[i];
                if (conversion.status === "complete") {
                  conversion.status = "success";
                  conversion.finish = Date.now();
                  
                  // TODO, attempt to match by vout.n index
                  //   they are suppose to be in same order, not necessarily same index ...
                  
                  let closestIndex = 0;
                  let closest = this.get_closest(vout_amounts, conversion.estimate);
                  for (let i in vout_amounts) {
                    if (vout_amounts[i] == closest) {
                      closestIndex = i;
                    }
                  }
                  if (closest !== conversion.received) {
                    //console.log("matched received n", conversion.n, closestIndex);
                    console.log("conversion fixup, received does not match closest to estimate!", conversion.received, closest);
                    conversion.received = closest;
                  }
                  console.log("conversion success", conversion.uid, conversion.txid);
                }
              }
            }
          }

        } else {
          console.error("unexpected txid ", (tx?tx.txid:''), " expected", txid);
        }
        
      } else if (rsp.error) {
        
        tx = { txid: txid, error: rsp.error };
        console.error("error response with getrawtransaction", txid, rsp.error);
        if (monitoringTx === true) {
          if (!this.txs[tx.txid]) {
            this.txs[tx.txid] = tx;
            console.log("add txid", tx.txid, "to monitor on error response", rsp.error);
          }  
        }

      } else {
        console.error("error with getrawtransaction", txid, rsp);
      }
      
      // remove some extra data we dont care about
      tx.hex = undefined;
      //tx.vin = tx.vin&&tx.vin.length?tx.vin.length:undefined;
      //tx.vout = tx.vout&&tx.vout.length?tx.vout.length:undefined;
      tx.vjoinsplit = tx.vjoinsplit&&tx.vjoinsplit.length?tx.vjoinsplit.length:undefined;
      tx.vShieldedSpend = tx.vShieldedSpend&&tx.vShieldedSpend.length?tx.vShieldedSpend.length:undefined;
      tx.vShieldedOutput = tx.vShieldedOutput&&tx.vShieldedOutput.length?tx.vShieldedOutput.length:undefined;
      //tx.valueBalance = tx.valueBalance?tx.valueBalance:undefined;
      tx.bindingSig = undefined;
      tx.overwintered = undefined;
      
      return tx;
    }

    async listOperationIDs(useCache=undefined) {
      // never use cache unless told otherwise
      await this.getOperationStatus([], (useCache===true?true:false));

      let r = {};
      // get counts of status types
      for(let opid in this.ops) {
        let op = this.ops[opid];
        if (op) {
          if (!op.status) { op.status = "unknown"; }
          if (!r[op.status]) {
            r[op.status] = 1;
          } else {
            r[op.status] += 1;
          }
        }
      }

      // add ops list
      r.ops = this.ops;

      return r;
    }
    
    async getOperationStatus(opids, useCache=undefined) {
      let r = undefined;
      let r_opids = [];
      // support single opid string input or array of opids as input
      if (opids) {
        if (Array.isArray(opids)) {
          r_opids = opids;
        } else {
          r_opids.push(opids);
        }
      }      
      let rsp = await this.request("z_getoperationstatus", [r_opids], useCache);
      if (rsp && !rsp.error) {
        r = rsp.result;
        for (let i in r) {
          let op = r[i];
          if (op) {
            // add to opid monitoring
            if (useCache===false) {
              //op.method = undefined;
              //op.params = undefined;
              this.add_opid(op);
            }
            // success
            if (op.result && op.result.txid) {
              // do not auto clear if we are trying to be fast with cache
              if (useCache === false) {
                  // clear from daemon by getting result
                  await this.getOperationResult(op.id, false);
              }
            }
          }
        }
      }
      return r;
    }
    
    async getOperationResult(opids, useCache=undefined) {
      let r = undefined;
      let r_opids = [];
      if (opids) {
        if (Array.isArray(opids)) {
          r_opids = opids;
        } else {
          r_opids.push(opids);
        }
      }
      let rsp = await this.request("z_getoperationresult", [r_opids], useCache);
      if (rsp && !rsp.error) {
        r = rsp.result;
        for (let i in r) {
          let op = r[i];
          if (op) {
            if (op.result && op.result.txid) {
              if (useCache === false) {
                // add txid for monitoring
                this.add_txid(op.result.txid);
              }
            }
            // clear from monitoring
            this.remove_opid(op);
          }
        }
      }
      return r;
    }
    
    async getFeeEstimate(nblocks=1) {
      let fee = 0.0001; // default to z-addr min
      let rsp = await this.request("estimatefee", [nblocks], false);
      if (rsp && !rsp.error) {
        fee = rsp.result;
      }
      return fee;
    }
    async getcurrencyconverters(params, useCache) {
      let r = undefined;
      let rsp = await this.request("getcurrencyconverters", params, useCache);
      if (rsp && !rsp.error) {
        r = rsp.result;
      }
      return r;
    }
    
    getConverters(params) {
      let found = [];
      for(let i in this.currencies) {
        let c = this.currencies[i];
        if (c && c.bestcurrencystate && c.bestcurrencystate.reservecurrencies && !c.isFailedLaunch && !c.isPrelaunch) {
          let count = 0;
          if (params.indexOf(c.currencyid) > -1) {
            count++;
          }
          for (let z in c.bestcurrencystate.reservecurrencies) {
            let r = c.bestcurrencystate.reservecurrencies[z];
            if (params.indexOf(r.currencyid) > -1) {
              count++;
            }
          }
          if (count >= params.length) {
            found.push(c.currencyid);
          }
        }
      }

      return found;
    }

    async estimateConversion(amount, from, to, via, preconvert, useCache) {
      let r = undefined;
      let params = {
        "amount":amount,
        "currency":from,
        "convertto":to
      };
      if (via) {
        params.via = via;
      }
      if (preconvert) {        
        params.preconvert = true;
      }
      let rsp = await this.request("estimateconversion", [params], useCache);
      if (rsp && !rsp.error) {
        r = rsp.result;
      }
      return r;
    }
    
    getCurrencyIdFromName(name) {
      if (this.currencyids[name]) { return this.currencyids[name]; }
      if (this.currencies[name]) { return name; }
      return undefined;
    }
    
    async sendCurrency(fromAddress, toArray=[], minconf=1, fee=0, verifyFirst=true) {
      let r = { invalid:[] };

      // if undefined, or empty string use * wildchar
      if (!fromAddress || (fromAddress && fromAddress.length == 0)) {
        fromAddress = "*";
      }
      // support wildchar in fromAddress
      if(fromAddress != "*" && fromAddress != "R*" && fromAddress != "i*") {
        // basic sanity check for user supplied data
        let validFrom = await this.isValidAddress(fromAddress);
        if (!validFrom) {
          r.invalid.push("fromAddress");
        }
      }
      
      let rpcMethod = "sendcurrency";
      if (toArray.length == 0) {
        r.invalid.push("toAddress0");
        r.invalid.push("amount0");
      }

      let hasPublicAddress = false;
      for (let i in toArray) {
        let to = toArray[i];
        let validTo = await this.isValidAddress(to.address);
        if (!validTo) {
          r.invalid.push("toAddress"+i);
        }
        if (!to.address.startsWith("zs1")) {
          hasPublicAddress = true;
        }

        // validate currencies and translate to currencyid if needed
        if (!to.currency) {
          to.currency = this.nativecurrencyid;
        } else {
          to.currency = this.getCurrencyIdFromName(to.currency);
          if (!to.currency) {
            r.invalid.push("currency"+i);
          }
        }
        if (to.via) {
          to.via = this.getCurrencyIdFromName(to.via);
          if (!to.via) {
            r.invalid.push("via"+i);
          }
        }
        if (to.exportto) {
          to.exportto = this.getCurrencyIdFromName(to.exportto);
          if (!to.exportto) {
            r.invalid.push("exportto"+i);
          }
        }
        
        // amount must be a positive number
        if (Number.isNaN(to.amount) || to.amount <= 0) {
          to.amount = 0;
          r.invalid.push("amount"+i);
        }
        to.amount = to.amount.toFixed(8);

        // z-addr can only accept native currency
        if (to.address.startsWith("zs1") && to.currency !== this.nativecurrencyid) {
          r.invalid.push("currency"+i);
        } else {
          // use z_sendmany when sending to self
          if (fromAddress == to.address && fromAddress.startsWith("zs1")) {
            // z_sendmany only works with native currency and does not support currency param
            rpcMethod = "z_sendmany";
          }
        }
        // if using z_sendmany, do not send currency unsupported
        if (rpcMethod == "z_sendmany") {
          to.currency = undefined;
        }
      }

      // can not send to self using z_sendmany with public addresses present
      if (hasPublicAddress && rpcMethod == "z_sendmany") {
        r.invalid.push("fromAddress");
      }

      let params = [fromAddress, toArray, minconf];
      if (fee && ( Number.isNaN(fee) || fee <= 0 )) {
        fee = undefined
        r.invalid.push("fee");
      }
      if (fee && fee > 0) { params.push(fee); } else { params.push(0) }

      // verifyFirst!
      if (verifyFirst || r.invalid.length > 0) {
        if (rpcMethod === "sendcurrency") {
          // returntxparams, to get fees
          let returntxparams = params.slice();
          returntxparams.push(1);
          if (returntxparams.length == 5) {
            //console.log("returntx", rpcMethod, returntxparams);
            let rsp = await this.request(rpcMethod, returntxparams, false);
            if (rsp && !rsp.error) {
              //console.log(rsp.result);
              let rawtxhex = rsp.result.hextx || rsp.result.hextxwithoutz || "";
              if (rawtxhex.length > 8) {
                let rsp2 = await this.request("decoderawtransaction", [rawtxhex], false);
                if (rsp2 && !rsp2.error) {
                  let fees = {};
                  if (!fees[this.nativecurrencyid]) {
                    fees[this.nativecurrencyid] = 0;
                  }
                  if (rsp.result.feeamount) {
                    fees[this.nativecurrencyid] += rsp.result.feeamount;
                    console.log("feeamount", rsp.result.feeamount, this.nativecurrencyid);
                  }
                  // go thru each vout checking for things
                  for (let n in rsp2.result.vout) {
                    let o = rsp2.result.vout[n];
                    if (o.scriptPubKey) {
                      if (o.scriptPubKey.reservetransfer) {
                        let feecurrency = o.scriptPubKey.reservetransfer.feecurrencyid;
                        if (!fees[feecurrency]) {
                          fees[feecurrency] = 0;
                        }
                        if (o.scriptPubKey.reservetransfer.fees) {
                          fees[feecurrency] += o.scriptPubKey.reservetransfer.fees;
                          //console.log("reservetransfer.fees", o.scriptPubKey.reservetransfer.fees, feecurrency);
                        }
                        if (o.scriptPubKey.reservetransfer.destination && o.scriptPubKey.reservetransfer.destination.fees) {
                          fees[feecurrency] += o.scriptPubKey.reservetransfer.destination.fees;
                          //console.log("reservetransfer.destination.fees", o.scriptPubKey.reservetransfer.destination.fees, feecurrency);
                        }
                      }
                    }
                  }
                  r.fees = fees;

                } else {
                  console.log("rsp2.error", rsp2.error);
                  r.invalid.push("error");
                  r.error = rsp2.error;
                }

              } else {
                if (!r.fees) { r.fees = {}; }
                if (fee && fee > 0) {
                  r.fees[this.nativecurrencyid] = fee;
                } else {
                  r.fees[this.nativecurrencyid] = 0.0001;
                }
              }

            } else {
              console.log("rsp.error", rsp.error);
              r.invalid.push("error");
              r.error = rsp.error;
            }
          }

        } else {
          if (!r.fees) { r.fees = {}; }
          if (fee && fee > 0) {
            r.fees[this.nativecurrencyid] = fee;
          } else {
            r.fees[this.nativecurrencyid] = 0.0001;
          }
        }

        r.verify = true;
        r.method = rpcMethod;
        r.params = params;
        return r;
      }

      console.log(rpcMethod, params);

      let rsp = await this.request(rpcMethod, params, false);
      if (rsp && !rsp.error) {
        r = {};
        r.opid = rsp.result;
        if (r.opid) {
          await this.getOperationStatus([r.opid], false);
        }
      } else {
        r = rsp;
      }
      
      console.log(r);

      return r;
    }

    async getNextBlockReward(useCache=undefined) {
      let r = undefined;
      let rsp = await this.request("getblocktemplate", [], useCache);
      if (rsp && !rsp.error) {
          r = {height: rsp.result.height, reward: 0, previousblockhash: rsp.result.previousblockhash, bits: rsp.result.bits, mergeminebits: rsp.result.mergeminebits};
          rsp = await this.request("decoderawtransaction", [rsp.result.coinbasetxn.data], useCache);
          if (rsp && !rsp.error) {
            if (rsp.result.vout && Array.isArray(rsp.result.vout) && rsp.result.vout[0].value) {
              r.reward = rsp.result.vout[0].value;
            }
          } else {
            console.error(rsp);
          }
      } else {
        console.error(rsp);
      }
      return r;
    }
    
    async getInfo(useCache=undefined) {
      let data = undefined;
      let rsp = await this.request("getinfo", [], useCache);
      if (rsp && !rsp.error) {
          data = rsp.result;
          currentBlockHeight = data.blocks;
          this.info = data;
      } else {
        console.error(rsp);
      }
      return data;
    }
    
    async getMiningInfo(useCache=undefined) {
      let data = undefined;
      let rsp = await this.request("getmininginfo", [], useCache);
      if (rsp && !rsp.error) {
          data = rsp.result;
      } else {
        console.error(rsp);
      }
      return data;
    }

    getReserveCurrencyPrice(state, baseid, quoteid, amount=1) {
      let baseReserves = 0;
      let baseWeight = 1;
      let quoteReserves = 0;
      let quoteWeight = 1;      
      let priceinreserve = 1;

      let cstate = state.currencystate;
      if (!cstate && state.bestcurrencystate) { cstate = state.bestcurrencystate; }
      if (!cstate && state.importnotarization && state.importnotarization.currencystate) { cstate = state.importnotarization.currencystate; }

      // check for reserve price
      for (let i in cstate.reservecurrencies) {
        let c = cstate.reservecurrencies[i];
        if (c.currencyid == baseid) {
          baseReserves = c.reserves;
          baseWeight = c.weight;
          priceinreserve = c.priceinreserve;
        }
        if (c.currencyid == quoteid) {
          quoteReserves = c.reserves;
          quoteWeight = c.weight;
          priceinreserve = c.priceinreserve;
        }
      }

      // if conversion thru basket
      if (baseReserves > 0 && quoteReserves > 0) {
        return ((quoteReserves / baseReserves) * (baseWeight / quoteWeight)) * amount;
      }

      // if converting from/to basket
      if (cstate.currencyid == baseid) {
        return priceinreserve * amount;
      }
      if (cstate.currencyid == quoteid) {
        return (1 / priceinreserve) * amount;
      }

      return 0;
    }
    
    async getCurrencyState(currencyid, startBlock, endBlock, step=1, quoteid=undefined) {
      let r = undefined;
      let params = [currencyid, [startBlock, endBlock, step].join(",")];
      if (quoteid) { params.push(quoteid); }
      let d = await this.request("getcurrencystate", params, true);
      if (d && !d.error && d.result) {
        r = d.result;
      }
      return r;
    }
    
    async getCurrency(lookup, useCache=undefined) {
      let r = undefined;
      let d = await this.request("getcurrency", [lookup], useCache);
      if (d && !d.error) {
        return await this.parseCurrency(d);
      }
      return r
    }
    
    async parseCurrency(d) {
      let r = undefined;
      if (d && !d.error) {
        let systemid = d.result.systemid;
        let currencyid = d.result.currencyid;
        let name = d.result.fullyqualifiedname;

        // cache currencyid > name table
        if (this.currencies[currencyid]) {
          // update currency cache
          this.currencies[currencyid] = d.result;
        } else {
          // initial cache: currency, id>name, name
          this.currencies[currencyid] = d.result;
          this.currencyids[name] = currencyid;
          this.currencynames[currencyid] = name;
        }

        // detection of options
        d.result.isToken = checkCurrencyOption(d.result.options, OPT_IS_TOKEN);
        d.result.isFractional = checkCurrencyOption(d.result.options, OPT_IS_FRACTIONAL);
        d.result.isPBaaS = checkCurrencyOption(d.result.options, OPT_IS_PBAAS);
        d.result.isGateway = checkCurrencyOption(d.result.options, OPT_IS_GATEWAY);
        d.result.isGatewayConverter = checkCurrencyOption(d.result.options, OPT_IS_GATEWAY_CONVERTER);
        d.result.isNFT = checkCurrencyOption(d.result.options, OPT_IS_NFT_TOKEN);
        
        // detect prelaunch
        if (this.info.blocks && d.result.startblock > this.info.blocks) {
          d.result.isPrelaunch = true;
        }
        // detect failed launch
        if (!d.result.isPrelaunch && d.result.isFractional && d.result.bestcurrencystate && d.result.bestcurrencystate.supply == 0) {
          d.result.isFailedLaunch = true;
        }
        /* TODO, check flags ?
        // detection of currenctstate flags
        if (d.result.bestcurrencystate && d.result.bestcurrencystate.flags) {
          d.result.isRefund = checkCurrencyFlag(d.result.bestcurrencystate.flags, FLAG_REFUNDING);
          if (d.result.isRefund) {
            console.log("refund", d.result.currencyid);
          }
        }
        */

        // gather market pricing
        if (this.currencies[currencyid].bestcurrencystate && this.currencies[currencyid].bestcurrencystate.reservecurrencies) {
          
          if (!d.result.liquidity) { d.result.liquidity = {}; }
          
          // calculate "peg" prices between each reserve currency
          for (let i in this.currencies[currencyid].bestcurrencystate.reservecurrencies) {
            let c = this.currencies[currencyid].bestcurrencystate.reservecurrencies[i];
            
            //let priceinreserve = (c.reserves / (d.result.bestcurrencystate.supply  * d.result.weights[i]));
            let liquidity = (d.result.bestcurrencystate.supply * c.priceinreserve);
            d.result.liquidity[c.currencyid] = liquidity;

            for (let z in this.currencies[currencyid].bestcurrencystate.reservecurrencies) {
              let cc = this.currencies[currencyid].bestcurrencystate.reservecurrencies[z];
              let price = this.getReserveCurrencyPrice(d.result, c.currencyid, cc.currencyid);
              if (price > -1 && Number.isFinite(price)) {
                if (!this.currencies[currencyid].bestcurrencystate.reservecurrencies[z].prices) { this.currencies[currencyid].bestcurrencystate.reservecurrencies[z].prices = {}; }
                this.currencies[currencyid].bestcurrencystate.reservecurrencies[z].prices[c.currencyid] = price;
              }
            }
          }
        }

        r = d.result;

        // add any cached market tickers from coinpaprika
        if (this.tickers[currencyid]) {
          r.coinpaprika = this.tickers[currencyid];
        }
      }

      return r;
    }
    
    async listCurrencies(params=[], useCache=undefined) {
      let rsp = await this.request("listcurrencies", params, useCache);
      if (rsp && !rsp.error) {
        let list = rsp.result;
        for (let i in list) {
          // basic sanity check
          if (list[i].currencydefinition && list[i].currencydefinition.currencyid) {
            let currencyid = list[i].currencydefinition.currencyid;

            let prelaunch = false;
            if (this.info && this.info.blocks && list[i].currencydefinition.startblock > this.info.blocks) {
              prelaunch = true;
            }

            // initially cache the currency if needed
            // also keep updating currencies in pre-launch
            if (!this.currencies[currencyid] || prelaunch) {
              let currency = await this.getCurrency(currencyid, (prelaunch?false:useCache));
              if (currency) {
                let parentid = currency.currencyid;
                let l = await this.request("listcurrencies", [{fromsystem:parentid}], useCache);
                if (l && !l.error && l.result) {
                  for (let r in l.result) {
                    if (l.result[r] && l.result[r].currencydefinition && l.result[r].currencydefinition.currencyid) {
                      let currencyid2 = l.result[r].currencydefinition.currencyid;
                      let currency2 = await this.getCurrency(currencyid2, useCache);
                    }
                  }
                }
              }
            }

          } else {
            console.error("unexpected currency definition", list[i]);
          }
        }
      }
    }
    
    isBasket(currencyid) {
      let c = this.currencies[currencyid];
      if (c && c.bestcurrencystate && c.bestcurrencystate.reservecurrencies && !c.isFailedLaunch) {
        return true;
      }
      return false;
    }
    
    async getBasketPrices(currencyid, quoteid=undefined, amount=undefined) {
      let cid = this.currencyids[currencyid]?this.currencyids[currencyid]:currencyid;
      let qid = this.currencyids[quoteid]?this.currencyids[quoteid]:quoteid;
      let baskets = this.getConverters([cid, qid]);

      let r = {
        baseid: cid,
        quoteid: qid,
        prices: []
      };

      for (let b in baskets) {
        let via = baskets[b];
        let price = this.getReserveCurrencyPrice(this.currencies[via], cid, qid, amount);
        let p = {
          via: via,
          price: price
        }
        r.prices.push(p);
      }

      r.prices.sort(function(a, b){
        return b.price - a.price;
      });

      return r;
    }
    
    async findBaskets(currencyid) {
      let r = [];
      for (let id in this.currencies) {
        let c = this.currencies[id];
        if (c.bestcurrencystate && c.bestcurrencystate.reservecurrencies && !c.isFailedLaunch) {
          let hasCurrency = false;
          for (let i in c.bestcurrencystate.reservecurrencies) {
            let rc = c.bestcurrencystate.reservecurrencies[i];
            if ((rc.currencyid == currencyid || rc.currencyid == this.currencyids[currencyid])) {
              hasCurrency = true;
            }
          }
          if (hasCurrency === true) {
            r.push(c.currencyid);
          }
        }
      }
      return r;
    }

    async getBaskets() {
      let r = [];
      for (let id in this.currencies) {
        let c = this.currencies[id];
        if (c.bestcurrencystate && c.bestcurrencystate.reservecurrencies && !c.isFailedLaunch) {
          r.push(c);
        }
      }
      r.sort(function(a, b){
        return b.bestcurrencystate.reservecurrencies[0].reserves - a.bestcurrencystate.reservecurrencies[0].reserves;
      });
      return r;
    }

    async getUnspentBlockRewards(useCache=undefined) {
      let r = [];
      let rsp = await this.request("listunspent", [], false, useCache);
      if (rsp && !rsp.error) {
        for (let i in rsp.result) {
          let utxo = rsp.result[i];
          if (utxo.generated && utxo.generated === true) {
            r.push(utxo);
          }
        }
      }
      return r;
    }

    async getOffers(currencyid, isCurrency=false, withtx=false, useCache=undefined) {
      let r = undefined;
      let rsp = await this.request("getoffers", [currencyid, isCurrency, withtx], useCache);
      if (rsp && !rsp.error) {
        r = rsp.result;
      }
      return r;
    }

    async getPendingTransfers(currencyid) {
      let r = undefined;
      let rsp = await this.request("getpendingtransfers", [currencyid], false);
      if (rsp && !rsp.error) {
        if (rsp.result && Array.isArray(rsp.result)) {
          r = rsp.result;
        }
      }
      return r;
    }

    async getImports(currencyid, startBlock, endBlock) {
      // basic sanity
      if (!startBlock || !endBlock) {
        return undefined;
      }
      if (endBlock < startBlock) {
        startBlock = endBlock;
      }
      // limit to max 10K records to process (20 x 500)
      if (endBlock - startBlock > 1440) {
        startBlock = (endBlock - 1440);
      }
      let r = undefined;
      let rsp = await this.request("getimports", [currencyid, startBlock, endBlock], true);
      if (rsp && !rsp.error) {
        if (rsp.result && Array.isArray(rsp.result)) {
          r = rsp.result;
        }
      }
      return r;
    }
    
    //***NOTE. this function is generally fast to return, but can miss some addresses with balances
    async getAddresses(useCache=undefined) {
      let addresses = {identities:[], public:[], private:[]};
      let rsp = await this.request("getaddressesbyaccount", [""], useCache);
      if (rsp && !rsp.error) {
        for (let a in rsp.result) {
          addresses.public.push(rsp.result[a]);
        }
      } else {
        console.error(rsp);
      }
      rsp = await this.request("listidentities", [], useCache);
      if (rsp && !rsp.error) {
        if (Array.isArray(rsp.result)) {
          for (let a in rsp.result) {
            addresses.identities.push(rsp.result[a].identity.identityaddress);
          }
        }
      } else {
        console.error(rsp);
      }
      rsp = await this.request("z_listaddresses", [], useCache);
      if (rsp && !rsp.error) {
        for (let a in rsp.result) {
          addresses.private.push(rsp.result[a]);
        }
      } else {
        console.error(rsp);
      }
      
      this.addresses = addresses;
      
      return addresses;
    }

    //***NOTE. this function can take a very long time to return
    async getCurrencyBalance(address, minconf=0, friendlynames=false, useCache=undefined) {
      let balance = undefined;
      let rsp = await this.request("getcurrencybalance", [address, minconf, friendlynames], useCache);
      if (rsp && !rsp.error) {
        balance = rsp.result;
      } else {
        console.error(rsp);
      }
      return balance;
    }

    //***NOTE. this function can take a very long time to return
    async z_getBalance(zaddress, minconf=0, useCache=undefined) {
      let balance = undefined;
      let rsp = await this.request("z_getbalance", [zaddress, minconf], useCache);
      if (rsp && !rsp.error) {
        balance = {"VRSC": rsp.result };
      } else {
        console.error(rsp);
      }
      return balance;
    }

    //***NOTE. this function can take a very long time to return
    async getBalances(minconf=0, useCache=undefined) {
      let totals = {};
      let currencynames = {};
      let balances = {};

      let addresses = await this.getAddresses(true);
      if (addresses !== undefined) {
        /*
        // check listaddressgroupings for any missed R* addresses
        let rsp = await this.request("listaddressgroupings", [], true);
        if (rsp && !rsp.error) {
            let groupings = rsp.result;
            for (let i in groupings) {
                for (let z in groupings[i]) {
                    let address = groupings[i][z][0];
                    if (address.startsWith("R") && addresses.public.indexOf(address) < 0) {
                      addresses.public.push(address);
                    }
                }
            }
        } else {
          console.error("error, listaddressgroupings", rsp);
          return {totals:totals, balances:balances};
        }
        */

        for (let i in addresses.identities) {
          let addr = addresses.identities[i];
          let rsp = await this.getCurrencyBalance(addr, minconf, false, false);
          if (rsp !== undefined) {
            for (let currencyid in rsp) {
              let name = this.currencies[currencyid].fullyqualifiedname || currencyid;
              if (!currencynames[currencyid]) {
                currencynames[currencyid] = name;
              }
              if (totals[currencyid]) {
                  totals[currencyid] += rsp[currencyid];
              } else {
                  totals[currencyid] = rsp[currencyid];
              }
              if (balances[currencyid] === undefined) {
                  balances[currencyid] = {};
              }
              if (balances[currencyid][addr]) {
                  balances[currencyid][addr] += rsp[currencyid];
              } else {
                  balances[currencyid][addr] = rsp[currencyid];
              }
            }
          }
        }
        
        for (let i in addresses.public) {
          let addr = addresses.public[i];
          let rsp = await this.getCurrencyBalance(addr, minconf, false, false);
          if (rsp !== undefined) {
            for (let currencyid in rsp) {
              let name = this.currencies[currencyid].fullyqualifiedname || currencyid;
              if (!currencynames[currencyid]) {
                currencynames[currencyid] = name;
              }
              if (totals[currencyid]) {
                  totals[currencyid] += rsp[currencyid];
              } else {
                  totals[currencyid] = rsp[currencyid];
              }
              if (balances[currencyid] === undefined) {
                  balances[currencyid] = {};
              }
              if (balances[currencyid][addr]) {
                  balances[currencyid][addr] += rsp[currencyid];
              } else {
                  balances[currencyid][addr] = rsp[currencyid];
              }
            }
          }
        }
        
        for (let i in addresses.private) {
          // zaddr can only have the native currency
          let currencyid = this.nativecurrencyid;
          let name = this.currencies[currencyid].fullyqualifiedname || currencyid;
          if (!currencynames[currencyid]) {
            currencynames[currencyid] = name;
          }
          let zaddr = addresses.private[i];
          let rsp = await this.request("z_getbalance", [zaddr, minconf], useCache);
          if (rsp && !rsp.error) {
              let balance = rsp.result;
              if (!balance) { balance = 0; }
              if (balance > 0) {
                  if (totals[currencyid]) {
                      totals[currencyid] += balance;
                  } else {
                      totals[currencyid] = balance;
                  }
                  if (balances[currencyid] === undefined) {
                      balances[currencyid] = {};
                  }
                  if (balances[currencyid][zaddr]) {
                      balances[currencyid][zaddr] += balance;
                  } else {
                      balances[currencyid][zaddr] = balance;
                  }
              }
          }
        }
      }
      
      return {totals:totals, currencynames:currencynames, balances:balances};
    }
};

module.exports = VerusRPC;