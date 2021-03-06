/**
 * @packageDocumentation
 * @module API-AVM
 */
import BN from 'bn.js';
import { Buffer } from 'buffer/';
import AvalancheCore from '../../avalanche';
import BinTools from '../../utils/bintools';
import { UTXOSet, UTXO } from './utxos';
import { AVMConstants } from './constants';
import { AVMKeyChain } from './keychain';
import { Tx, UnsignedTx } from './tx';
import { PayloadBase } from '../../utils/payload';
import { TransferableInput, SecpInput } from './inputs';
import { AmountOutput } from './outputs';
import { InitialStates } from './initialstates';
import { UnixNow } from '../../utils/helperfunctions';
import { JRPCAPI } from '../../common/jrpcapi';
import { RequestResponseData } from '../../common/apibase';
import { Defaults, PlatformChainID, PrimaryAssetAlias } from '../../utils/constants';
import { MinterSet } from './minterset';
import { PersistanceOptions } from '../../utils/persistenceoptions';

/**
 * @ignore
 */
const bintools = BinTools.getInstance();


/**
 * Class for interacting with a node endpoint that is using the AVM.
 *
 * @category RPCAPIs
 *
 * @remarks This extends the [[JRPCAPI]] class. This class should not be directly called. Instead, use the [[Avalanche.addAPI]] function to register this interface with Avalanche.
 */
export class AVMAPI extends JRPCAPI {
  /**
   * @ignore
   */
  protected keychain:AVMKeyChain = new AVMKeyChain('', '');

  protected blockchainID:string = '';

  protected AVAXAssetID:Buffer = undefined;

  protected fee:BN = undefined;

  /**
     * Gets the alias for the blockchainID if it exists, otherwise returns `undefined`.
     *
     * @returns The alias for the blockchainID
     */
  getBlockchainAlias = ():string => {
    const netid:number = this.core.getNetworkID();
    if (netid in Defaults.network && this.blockchainID in Defaults.network[netid]) {
      return Defaults.network[netid][this.blockchainID].alias;
    }
    /* istanbul ignore next */
    return undefined;
  };

  /**
     * Gets the blockchainID and returns it.
     *
     * @returns The blockchainID
     */
  getBlockchainID = ():string => this.blockchainID;

  /**
     * Refresh blockchainID, and if a blockchainID is passed in, use that.
     *
     * @param Optional. BlockchainID to assign, if none, uses the default based on networkID.
     *
     * @returns The blockchainID
     */
  refreshBlockchainID = (blockchainID:string = undefined):boolean => {
    const netid:number = this.core.getNetworkID();
    if (typeof blockchainID === 'undefined' && typeof Defaults.network[netid] !== "undefined") {
      this.blockchainID = Defaults.network[netid].X.blockchainID; //default to X-Chain
      return true;
    } if (typeof blockchainID === 'string') {
      this.blockchainID = blockchainID;
      return true;
    }
    return false;
  };

  /**
     * Takes an address string and returns its {@link https://github.com/feross/buffer|Buffer} representation if valid.
     *
     * @returns A {@link https://github.com/feross/buffer|Buffer} for the address if valid, undefined if not valid.
     */
  parseAddress = (addr:string):Buffer => {
    const alias:string = this.getBlockchainAlias();
    const blockchainID:string = this.getBlockchainID();
    return bintools.parseAddress(addr, blockchainID, alias, AVMConstants.ADDRESSLENGTH);
  };

  addressFromBuffer = (address:Buffer):string => {
    const chainid:string = this.getBlockchainAlias() ? this.getBlockchainAlias() : this.getBlockchainID();
    return bintools.addressToString(this.core.getHRP(), chainid, address);
  };

  /**
   * Fetches the AVAX AssetID and returns it in a Promise.
   *
   * @returns The the provided string representing the AVAX AssetID
   */
  getAVAXAssetID = async ():Promise<Buffer> => {
    if (typeof this.AVAXAssetID === 'undefined') {
      const asset:{
        name: string;
        symbol: string;
        assetID: Buffer;
        denomination: number;
      } = await this.getAssetDescription(PrimaryAssetAlias);
      this.AVAXAssetID = asset.assetID;
    }
    return this.AVAXAssetID;
  };

  /**
   * Gets the default fee for this chain.
   *
   * @returns The default fee as a {@link https://github.com/indutny/bn.js/|BN}
   */
  getDefaultFee =  ():BN => {
    return this.core.getNetworkID() in Defaults.network ? new BN(Defaults.network[this.core.getNetworkID()]["X"]["fee"]) : new BN(0);
  }

  /**
   * Gets the fee for this chain.
   *
   * @returns The fee as a {@link https://github.com/indutny/bn.js/|BN}
   */
  getFee = ():BN => {
    if(typeof this.fee === "undefined") {
      this.fee = this.getDefaultFee();
    }
    return this.fee;
  }

  /**
   * Sets the fee for this chain.
   *
   * @param fee The fee amount to set as {@link https://github.com/indutny/bn.js/|BN}
   */
  setFee = (fee:BN) => {
    this.fee = fee;
  }

  /**
   * Gets a reference to the keychain for this class.
   *
   * @returns The instance of [[AVMKeyChain]] for this class
   */
  keyChain = ():AVMKeyChain => this.keychain;

  /**
   * @ignore
   */
  newKeyChain = ():AVMKeyChain => {
    // warning, overwrites the old keychain
    const alias = this.getBlockchainAlias();
    if (alias) {
      this.keychain = new AVMKeyChain(this.core.getHRP(), alias);
    } else {
      this.keychain = new AVMKeyChain(this.core.getHRP(), this.blockchainID);
    }
    return this.keychain;
  };

  /**
   * Helper function which determines if a tx is a goose egg transaction. 
   *
   * @param utx An UnsignedTx
   *
   * @returns boolean true if passes goose egg test and false if fails.
   *
   * @remarks
   * A "Goose Egg Transaction" is when the fee far exceeds a reasonable amount
   */
  checkGooseEgg = async (utx:UnsignedTx): Promise<boolean> => {
    const avaxAssetID:Buffer = await this.getAVAXAssetID();
    let outputTotal:BN = utx.getOutputTotal(avaxAssetID);
    const fee:BN = utx.getBurn(avaxAssetID);
    if(fee.lte(AVMConstants.ONEAVAX.mul(new BN(10))) || fee.lte(outputTotal)) {
      return true;
    } else {
      return false;
    }
  }

  /**
     * Gets the balance of a particular asset on a blockchain.
     *
     * @param address The address to pull the asset balance from
     * @param assetID The assetID to pull the balance from
     *
     * @returns Promise with the balance of the assetID as a {@link https://github.com/indutny/bn.js/|BN} on the provided address for the blockchain.
     */
  getBalance = async (address:string, assetID:string):Promise<object> => {
    if (typeof this.parseAddress(address) === 'undefined') {
      /* istanbul ignore next */
      throw new Error(`Error - AVMAPI.getBalance: Invalid address format ${address}`);
    }
    const params:any = {
      address,
      assetID,
    };
    return this.callMethod('avm.getBalance', params).then((response:RequestResponseData) => response.data.result);
  };

  /**
     * Creates an address (and associated private keys) on a user on a blockchain.
     *
     * @param username Name of the user to create the address under
     * @param password Password to unlock the user and encrypt the private key
     *
     * @returns Promise for a string representing the address created by the vm.
     */
  createAddress = async (username:string, password:string):Promise<string> => {
    const params:any = {
      username,
      password,
    };
    return this.callMethod('avm.createAddress', params).then((response:RequestResponseData) => response.data.result.address);
  };

  /**
   * Create a new fixed-cap, fungible asset. A quantity of it is created at initialization and there no more is ever created.
   *
   * @param username The user paying the transaction fee (in $AVAX) for asset creation
   * @param password The password for the user paying the transaction fee (in $AVAX) for asset creation
   * @param name The human-readable name for the asset
   * @param symbol Optional. The shorthand symbol for the asset. Between 0 and 4 characters
   * @param denomination Optional. Determines how balances of this asset are displayed by user interfaces. Default is 0
   * @param initialHolders An array of objects containing the field "address" and "amount" to establish the genesis values for the new asset
   *
   * ```js
   * Example initialHolders:
   * [
   *     {
   *         "address": "X-avax1kj06lhgx84h39snsljcey3tpc046ze68mek3g5",
   *         "amount": 10000
   *     },
   *     {
   *         "address": "X-avax1am4w6hfrvmh3akduzkjthrtgtqafalce6an8cr",
   *         "amount": 50000
   *     }
   * ]
   * ```
   *
   * @returns Returns a Promise<string> containing the base 58 string representation of the ID of the newly created asset.
   */
  createFixedCapAsset = async (username:string, password:string, name:string, symbol:string, denomination:number, initialHolders:Array<object>):Promise<string> => {
    const params:any = {
      name,
      symbol,
      denomination,
      username,
      password,
      initialHolders,
    };
    return this.callMethod('avm.createFixedCapAsset', params).then((response:RequestResponseData) => response.data.result.assetID);
  };

  /**
     * Create a new variable-cap, fungible asset. No units of the asset exist at initialization. Minters can mint units of this asset using createMintTx, signMintTx and sendMintTx.
     *
     * @param username The user paying the transaction fee (in $AVAX) for asset creation
     * @param password The password for the user paying the transaction fee (in $AVAX) for asset creation
     * @param name The human-readable name for the asset
     * @param symbol Optional. The shorthand symbol for the asset -- between 0 and 4 characters
     * @param denomination Optional. Determines how balances of this asset are displayed by user interfaces. Default is 0
     * @param minterSets is a list where each element specifies that threshold of the addresses in minters may together mint more of the asset by signing a minting transaction
     * 
     * ```js
     * Example minterSets:
     * [
     *      {
     *          "minters":[
     *              "X-avax1am4w6hfrvmh3akduzkjthrtgtqafalce6an8cr"
     *          ],
     *          "threshold": 1
     *      },
     *      {
     *          "minters": [
     *              "X-avax1am4w6hfrvmh3akduzkjthrtgtqafalce6an8cr",
     *              "X-avax1kj06lhgx84h39snsljcey3tpc046ze68mek3g5",
     *              "X-avax1yell3e4nln0m39cfpdhgqprsd87jkh4qnakklx"
     *          ],
     *          "threshold": 2
     *      }
     * ]
     * ```
     *
     * @returns Returns a Promise<string> containing the base 58 string representation of the ID of the newly created asset.
     */
  createVariableCapAsset = async (username:string, password:string, name:string, symbol:string, denomination:number, minterSets:Array<object>):Promise<string> => {
    const params:any = {
      name,
      symbol,
      denomination,
      username,
      password,
      minterSets,
    };
    return this.callMethod('avm.createVariableCapAsset', params).then((response:RequestResponseData) => response.data.result.assetID);
  };

  /**
     * Create an unsigned transaction to mint more of an asset.
     *
     * @param amount The units of the asset to mint
     * @param assetID The ID of the asset to mint
     * @param to The address to assign the units of the minted asset
     * @param minters Addresses of the minters responsible for signing the transaction
     *
     * @returns Returns a Promise<string> containing the base 58 string representation of the unsigned transaction.
     */
  mint = async (username:string, password:string, amount:number | BN, assetID:Buffer | string, to:string, minters:Array<string>):Promise<string> => {
    let asset:string;
    let amnt:BN;
    if (typeof assetID !== 'string') {
      asset = bintools.cb58Encode(assetID);
    } else {
      asset = assetID;
    }
    if (typeof amount === 'number') {
      amnt = new BN(amount);
    } else {
      amnt = amount;
    }
    const params:any = {
      username: username,
      password: password,
      amount: amnt.toString(10),
      assetID: asset,
      to,
      minters
    };
    return this.callMethod('avm.mint', params).then((response:RequestResponseData) => response.data.result.txID);
  };

  /**
     * Exports the private key for an address.
     *
     * @param username The name of the user with the private key
     * @param password The password used to decrypt the private key
     * @param address The address whose private key should be exported
     *
     * @returns Promise with the decrypted private key as store in the database
     */
  exportKey = async (username:string, password:string, address:string):Promise<string> => {
    if (typeof this.parseAddress(address) === 'undefined') {
      /* istanbul ignore next */
      throw new Error(`Error - AVMAPI.exportKey: Invalid address format ${address}`);
    }
    const params:any = {
      username,
      password,
      address,
    };
    return this.callMethod('avm.exportKey', params).then((response:RequestResponseData) => response.data.result.privateKey);
  };

  /**
     * Imports a private key into the node's keystore under an user and for a blockchain.
     *
     * @param username The name of the user to store the private key
     * @param password The password that unlocks the user
     * @param privateKey A string representing the private key in the vm's format
     *
     * @returns The address for the imported private key.
     */
  importKey = async (username:string, password:string, privateKey:string):Promise<string> => {
    const params:any = {
      username,
      password,
      privateKey,
    };
    return this.callMethod('avm.importKey', params).then((response:RequestResponseData) => response.data.result.address);
  };

  /**
     * Send AVAX from the X-Chain to an account on the P-Chain.
     *
     * After calling this method, you must call the P-Chain’s importAVAX method to complete the transfer.
     *
     * @param username The Keystore user that controls the P-Chain account specified in `to`
     * @param password The password of the Keystore user
     * @param to The account on the P-Chain to send the AVAX to. Do not include P- in the address
     * @param amount Amount of AVAX to export as a {@link https://github.com/indutny/bn.js/|BN}
     *
     * @returns String representing the transaction id
     */
  exportAVAX = async (username:string, password:string, to:string, amount:BN):Promise<string> => {
    const params:any = {
      to,
      amount: amount.toString(10),
      username,
      password,
    };
    return this.callMethod('avm.exportAVAX', params).then((response:RequestResponseData) => response.data.result.txID);
  };

  /**
     * Finalize a transfer of AVAX from the P-Chain to the X-Chain.
     *
     * Before this method is called, you must call the P-Chain’s `exportAVAX` method to initiate the transfer.
     * @param username The Keystore user that controls the address specified in `to`
     * @param password The password of the Keystore user
     * @param to The address the AVAX is sent to. This must be the same as the to argument in the corresponding call to the P-Chain’s exportAVAX, except that the prepended X- should be included in this argument
     * @param sourceChain Chain the funds are coming from.
     *
     * @returns String representing the transaction id
     */
  importAVAX = async (username:string, password:string, to:string, sourceChain:string):Promise<string> => {
    const params:any = {
      to,
      sourceChain,
      username,
      password,
    };
    return this.callMethod('avm.importAVAX', params).then((response:RequestResponseData) => response.data.result.txID);
  };

  /**
     * Lists all the addresses under a user.
     *
     * @param username The user to list addresses
     * @param password The password of the user to list the addresses
     *
     * @returns Promise of an array of address strings in the format specified by the blockchain.
     */
  listAddresses = async (username:string, password:string): Promise<Array<string>> => {
    const params:any = {
      username,
      password,
    };
    return this.callMethod('avm.listAddresses', params).then((response:RequestResponseData) => response.data.result.addresses);
  };

  /**
     * Retrieves all assets for an address on a server and their associated balances.
     *
     * @param address The address to get a list of assets
     *
     * @returns Promise of an object mapping assetID strings with {@link https://github.com/indutny/bn.js/|BN} balance for the address on the blockchain.
     */
  getAllBalances = async (address:string):Promise<Array<object>> => {
    if (typeof this.parseAddress(address) === 'undefined') {
      /* istanbul ignore next */
      throw new Error(`Error - AVMAPI.getAllBalances: Invalid address format ${address}`);
    }
    const params:any = {
      address,
    };
    return this.callMethod('avm.getAllBalances', params).then((response:RequestResponseData) => response.data.result.balances);
  };

  /**
     * Retrieves an assets name and symbol.
     *
     * @param assetID Either a {@link https://github.com/feross/buffer|Buffer} or an b58 serialized string for the AssetID or its alias.
     *
     * @returns Returns a Promise<object> with keys "name" and "symbol".
     */
  getAssetDescription = async (assetID:Buffer | string):Promise<{name:string;symbol:string;assetID:Buffer;denomination:number}> => {
    let asset:string;
    if (typeof assetID !== 'string') {
      asset = bintools.cb58Encode(assetID);
    } else {
      asset = assetID;
    }
    const params:any = {
      assetID: asset,
    };
    return this.callMethod('avm.getAssetDescription', params).then((response:RequestResponseData) => ({
      name: response.data.result.name,
      symbol: response.data.result.symbol,
      assetID: bintools.cb58Decode(response.data.result.assetID),
      denomination: parseInt(response.data.result.denomination, 10),
    }));
  };

  /**
   * Returns the treansaction data of a provided transaction ID by calling the node's `getTx` method.
   *
   * @param txid The string representation of the transaction ID
   *
   * @returns Returns a Promise<string> containing the bytes retrieved from the node
   */
  getTx = async (txid:string):Promise<string> => {
    const params:any = {
      txID: txid,
    };
    return this.callMethod('avm.getTx', params).then((response:RequestResponseData) => response.data.result.tx);
  };

  /**
   * Returns the status of a provided transaction ID by calling the node's `getTxStatus` method.
   *
   * @param txid The string representation of the transaction ID
   *
   * @returns Returns a Promise<string> containing the status retrieved from the node
   */
  getTxStatus = async (txid:string):Promise<string> => {
    const params:any = {
      txID: txid,
    };
    return this.callMethod('avm.getTxStatus', params).then((response:RequestResponseData) => response.data.result.status);
  };

  /**
   * Retrieves the UTXOs related to the addresses provided from the node's `getUTXOs` method.
   *
   * @param addresses An array of addresses as cb58 strings or addresses as {@link https://github.com/feross/buffer|Buffer}s
   * @param limit Optional. Returns at most [limit] addresses. If [limit] == 0 or > [maxUTXOsToFetch], fetches up to [maxUTXOsToFetch].
   * @param startIndex Optional. [StartIndex] defines where to start fetching UTXOs (for pagination.)
   * UTXOs fetched are from addresses equal to or greater than [StartIndex.Address]
   * For address [StartIndex.Address], only UTXOs with IDs greater than [StartIndex.Utxo] will be returned.
   * @param persistOpts Options available to persist these UTXOs in local storage
   *
   * @remarks
   * persistOpts is optional and must be of type [[PersistanceOptions]]
   *
   */
  getUTXOs = async (
    addresses:Array<string> | Array<Buffer>,
    limit:number = 0,
    startIndex:number = undefined,
    persistOpts:PersistanceOptions = undefined
  ):Promise<UTXOSet> => {
    const addrs:Array<string> = this._cleanAddressArray(addresses, 'getUTXOs');

    const params:any = {
      addresses: addrs,
      limit,
    };
    if(typeof startIndex !== "undefined"){
      params.startIndex = startIndex;
    }
    return this.callMethod('avm.getUTXOs', params).then((response:RequestResponseData) => {
      const utxos:UTXOSet = new UTXOSet();
      let data = response.data.result.utxos;
      if (persistOpts && typeof persistOpts === 'object') {
        if (this.db.has(persistOpts.getName())) {
          const selfArray:Array<string> = this.db.get(persistOpts.getName());
          if (Array.isArray(selfArray)) {
            utxos.addArray(data);
            const self:UTXOSet = new UTXOSet();
            self.addArray(selfArray);
            self.mergeByRule(utxos, persistOpts.getMergeRule());
            data = self.getAllUTXOStrings();
          }
        }
        this.db.set(persistOpts.getName(), data, persistOpts.getOverwrite());
      }
      utxos.addArray(data);
      return utxos;
    });
  };

  /**
     * Helper function which creates an unsigned transaction. For more granular control, you may create your own
     * [[UnsignedTx]] manually (with their corresponding [[TransferableInput]]s, [[TransferableOutput]]s, and [[TransferOperation]]s).
     *
     * @param utxoset A set of UTXOs that the transaction is built on
     * @param amount The amount of AssetID to be spent in its smallest denomination, represented as {@link https://github.com/indutny/bn.js/|BN}.
     * @param assetID The assetID of the value being sent
     * @param toAddresses The addresses to send the funds
     * @param fromAddresses The addresses being used to send the funds from the UTXOs provided
     * @param changeAddresses The addresses that can spend the change remaining from the spent UTXOs
     * @param memo Optional contains arbitrary bytes, up to 256 bytes
     * @param asOf Optional. The timestamp to verify the transaction against as a {@link https://github.com/indutny/bn.js/|BN}
     * @param locktime Optional. The locktime field created in the resulting outputs
     * @param threshold Optional. The number of signatures required to spend the funds in the resultant UTXO
     *
     * @returns An unsigned transaction ([[UnsignedTx]]) which contains a [[BaseTx]].
     *
     * @remarks
     * This helper exists because the endpoint API should be the primary point of entry for most functionality.
     */
  buildBaseTx = async (
    utxoset:UTXOSet, 
    amount:BN, 
    assetID:Buffer | string = undefined, 
    toAddresses:Array<string>, 
    fromAddresses:Array<string>,
    changeAddresses:Array<string>, 
    memo:PayloadBase|Buffer = undefined, 
    asOf:BN = UnixNow(),
    locktime:BN = new BN(0), 
    threshold:number = 1
  ):Promise<UnsignedTx> => {
    const to:Array<Buffer> = this._cleanAddressArray(toAddresses, 'buildBaseTx').map((a) => bintools.stringToAddress(a));
    const from:Array<Buffer> = this._cleanAddressArray(fromAddresses, 'buildBaseTx').map((a) => bintools.stringToAddress(a));
    const change:Array<Buffer> = this._cleanAddressArray(changeAddresses, 'buildBaseTx').map((a) => bintools.stringToAddress(a));

    if (typeof assetID === 'string') {
      assetID = bintools.cb58Decode(assetID);
    }

    if( memo instanceof PayloadBase) {
      memo = memo.getPayload();
    }

    const builtUnsignedTx:UnsignedTx = utxoset.buildBaseTx(
      this.core.getNetworkID(), 
      bintools.cb58Decode(this.blockchainID),
      amount, 
      assetID, 
      to, 
      from, 
      change, 
      this.getFee(), 
      await this.getAVAXAssetID(),
      memo, asOf, locktime, threshold,
    );

    if(! await this.checkGooseEgg(builtUnsignedTx)) {
      /* istanbul ignore next */
      throw new Error("Failed Goose Egg Check");
    }

    return builtUnsignedTx;
  };

  /**
     * Helper function which creates an unsigned NFT Transfer. For more granular control, you may create your own
     * [[UnsignedTx]] manually (with their corresponding [[TransferableInput]]s, [[TransferableOutput]]s, and [[TransferOperation]]s).
     *
     * @param utxoset  A set of UTXOs that the transaction is built on
     * @param toAddresses The addresses to send the NFT
     * @param fromAddresses The addresses being used to send the NFT from the utxoID provided
     * @param utxoid A base58 utxoID or an array of base58 utxoIDs for the nfts this transaction is sending
     * @param memo Optional contains arbitrary bytes, up to 256 bytes
     * @param asOf Optional. The timestamp to verify the transaction against as a {@link https://github.com/indutny/bn.js/|BN}
     * @param locktime Optional. The locktime field created in the resulting outputs
     * @param threshold Optional. The number of signatures required to spend the funds in the resultant UTXO
     *
     * @returns An unsigned transaction ([[UnsignedTx]]) which contains a [[NFTTransferTx]].
     *
     * @remarks
     * This helper exists because the endpoint API should be the primary point of entry for most functionality.
     */
  buildNFTTransferTx = async (
    utxoset:UTXOSet, 
    toAddresses:Array<string>, 
    fromAddresses:Array<string>, 
    utxoid:string | Array<string>, 
    memo:PayloadBase|Buffer = undefined, 
    asOf:BN = UnixNow(), 
    locktime:BN = new BN(0), 
    threshold:number = 1,
  ):Promise<UnsignedTx> => {
    const to:Array<Buffer> = this._cleanAddressArray(toAddresses, 'buildNFTTransferTx').map((a) => bintools.stringToAddress(a));
    const from:Array<Buffer> = this._cleanAddressArray(fromAddresses, 'buildNFTTransferTx').map((a) => bintools.stringToAddress(a));

    if( memo instanceof PayloadBase) {
      memo = memo.getPayload();
    }
    const avaxAssetID:Buffer = await this.getAVAXAssetID();

    let utxoidArray:Array<string> = [];
    if (typeof utxoid === 'string') {
      utxoidArray = [utxoid];
    } else if (Array.isArray(utxoid)) {
      utxoidArray = utxoid;
    }

    const builtUnsignedTx:UnsignedTx = utxoset.buildNFTTransferTx(
      this.core.getNetworkID(), 
      bintools.cb58Decode(this.blockchainID), 
      to, 
      from, 
      utxoidArray, 
      this.getFee(),
      avaxAssetID, 
      memo, asOf, locktime, threshold,
    );

    if(! await this.checkGooseEgg(builtUnsignedTx)) {
      /* istanbul ignore next */
      throw new Error("Failed Goose Egg Check");
    }

    return builtUnsignedTx;
  };

/**
 * Helper function which creates an unsigned Import Tx. For more granular control, you may create your own
 * [[UnsignedTx]] manually (with their corresponding [[TransferableInput]]s, [[TransferableOutput]]s, and [[TransferOperation]]s).
 *
 * @param utxoset  A set of UTXOs that the transaction is built on
 * @param ownerAddresses The addresses being used to import
 * @param sourceChain The chainid for where the import is coming from. Default, platform chainid. 
 * @param memo Optional contains arbitrary bytes, up to 256 bytes
 * @param asOf Optional. The timestamp to verify the transaction against as a {@link https://github.com/indutny/bn.js/|BN}
 *
 * @returns An unsigned transaction ([[UnsignedTx]]) which contains a [[ImportTx]].
 *
 * @remarks
 * This helper exists because the endpoint API should be the primary point of entry for most functionality.
 */
buildImportTx = async (
  utxoset:UTXOSet, 
  ownerAddresses:Array<string>, 
  sourceChain:Buffer | string = undefined,
  memo:PayloadBase|Buffer = undefined, 
  asOf:BN = UnixNow(), 
):Promise<UnsignedTx> => {
  const owners:Array<Buffer> = this._cleanAddressArray(ownerAddresses, 'buildImportTx').map((a) => bintools.stringToAddress(a));

  const atomicUTXOs:UTXOSet = await this.getUTXOs(owners);
  const avaxAssetID:Buffer = await this.getAVAXAssetID();
  const avaxAssetIDStr:string = avaxAssetID.toString("hex");


  if( memo instanceof PayloadBase) {
    memo = memo.getPayload();
  }

  if (typeof sourceChain === "string") {
    sourceChain = bintools.cb58Decode(PlatformChainID);
  } else if(!(sourceChain instanceof Buffer)) {
    throw new Error("Error - AVMAPI.buildImportTx: Invalid destinationChain type: " + (typeof sourceChain) );
  }
  
  const atomics = atomicUTXOs.getAllUTXOs();
  const importIns:Array<TransferableInput> = [];
  for(let i:number = 0; i < atomics.length; i++) {
    const utxo:UTXO = atomics[i];
    const assetID:Buffer = utxo.getAssetID();
    if(assetID.toString("hex") === avaxAssetIDStr) {
      const output:AmountOutput = utxo.getOutput() as AmountOutput;
      const amt:BN = output.getAmount().clone();
      const txid:Buffer = utxo.getTxID();
      const outputidx:Buffer = utxo.getOutputIdx();
      const input:SecpInput = new SecpInput(amt);
      const xferin:TransferableInput = new TransferableInput(txid, outputidx, assetID, input);
      const fromAddresses:Array<Buffer> = output.getAddresses(); // Verify correct approach
      const spenders:Array<Buffer> = output.getSpenders(fromAddresses, asOf);
      for (let j = 0; j < spenders.length; j++) {
        const idx:number = output.getAddressIdx(spenders[j]);
        if (idx === -1) {
          /* istanbul ignore next */
          throw new Error('Error - UTXOSet.buildImportTx: no such '
          + `address in output: ${spenders[j]}`);
        }
        xferin.getInput().addSignatureIdx(idx, spenders[j]);
      }
      importIns.push(xferin);
    }
  }
  
  const builtUnsignedTx:UnsignedTx = utxoset.buildImportTx(
    this.core.getNetworkID(), 
    bintools.cb58Decode(this.blockchainID), 
    owners,
    importIns, 
    sourceChain,
    this.getFee(), 
    avaxAssetID, 
    memo, asOf
  );

    if(! await this.checkGooseEgg(builtUnsignedTx)) {
      /* istanbul ignore next */
      throw new Error("Failed Goose Egg Check");
    }

    return builtUnsignedTx;
  };

  /**
   * Helper function which creates an unsigned Export Tx. For more granular control, you may create your own
   * [[UnsignedTx]] manually (with their corresponding [[TransferableInput]]s, [[TransferableOutput]]s, and [[TransferOperation]]s).
   *
   * @param utxoset A set of UTXOs that the transaction is built on
   * @param amount The amount being exported as a {@link https://github.com/indutny/bn.js/|BN}
   * @param toAddresses The addresses to send the funds
   * @param fromAddresses The addresses being used to send the funds from the UTXOs provided
   * @param changeAddresses The addresses that can spend the change remaining from the spent UTXOs
   * @param destinationChain The chainid for where the assets will be sent. Default platform chainid.
   * @param memo Optional contains arbitrary bytes, up to 256 bytes
   * @param asOf Optional. The timestamp to verify the transaction against as a {@link https://github.com/indutny/bn.js/|BN}
   * @param locktime Optional. The locktime field created in the resulting outputs
   * @param threshold Optional. The number of signatures required to spend the funds in the resultant UTXO
   *
   * @returns An unsigned transaction ([[UnsignedTx]]) which contains an [[ExportTx]].
   */
  buildExportTx = async (
    utxoset:UTXOSet, 
    amount:BN,
    toAddresses:Array<string>, 
    fromAddresses:Array<string>,
    changeAddresses:Array<string> = undefined,
    destinationChain:Buffer | string = undefined,
    memo:PayloadBase|Buffer = undefined, 
    asOf:BN = UnixNow(),
    locktime:BN = new BN(0), 
    threshold:number = 1
  ):Promise<UnsignedTx> => {
    const to:Array<Buffer> = this._cleanAddressArray(toAddresses, 'buildBaseTx').map((a) => bintools.stringToAddress(a));
    const from:Array<Buffer> = this._cleanAddressArray(fromAddresses, 'buildBaseTx').map((a) => bintools.stringToAddress(a));
    const change:Array<Buffer> = this._cleanAddressArray(changeAddresses, 'buildBaseTx').map((a) => bintools.stringToAddress(a));

    if( memo instanceof PayloadBase) {
      memo = memo.getPayload();
    }

    const avaxAssetID:Buffer = await this.getAVAXAssetID();

    if (typeof destinationChain === "string") {
      destinationChain = bintools.cb58Decode(PlatformChainID);
    } else if(!(destinationChain instanceof Buffer)) {
      throw new Error("Error - AVMAPI.buildExportTx: Invalid destinationChain type: " + (typeof destinationChain) );
    }

    const builtUnsignedTx:UnsignedTx = utxoset.buildExportTx(
      this.core.getNetworkID(), 
      bintools.cb58Decode(this.blockchainID), 
      amount,
      avaxAssetID, 
      to,
      from,
      change,
      destinationChain,
      this.getFee(), 
      avaxAssetID,
      memo, asOf, locktime, threshold
    );

    if(! await this.checkGooseEgg(builtUnsignedTx)) {
      /* istanbul ignore next */
      throw new Error("Failed Goose Egg Check");
    }

    return builtUnsignedTx;
  };

  /**
   * Creates an unsigned transaction. For more granular control, you may create your own
   * [[UnsignedTx]] manually (with their corresponding [[TransferableInput]]s, [[TransferableOutput]]s, and [[TransferOperation]]s).
   *
   * @param utxoset A set of UTXOs that the transaction is built on
   * @param fromAddresses The addresses being used to send the funds from the UTXOs {@link https://github.com/feross/buffer|Buffer}
   * @param initialState The [[InitialStates]] that represent the intial state of a created asset
   * @param name String for the descriptive name of the asset
   * @param symbol String for the ticker symbol of the asset
   * @param denomination Optional number for the denomination which is 10^D. D must be >= 0 and <= 32. Ex: $1 AVAX = 10^9 $nAVAX
   * @param memo Optional contains arbitrary bytes, up to 256 bytes
   * @param asOf Optional. The timestamp to verify the transaction against as a {@link https://github.com/indutny/bn.js/|BN}
   *
   * @returns An unsigned transaction ([[UnsignedTx]]) which contains a [[CreateAssetTx]].
   * 
   */
  buildCreateAssetTx = async (
      utxoset:UTXOSet, 
      fromAddresses:Array<string> | Array<Buffer>, 
      initialStates:InitialStates, 
      name:string, 
      symbol:string, 
      denomination:number, 
      memo:PayloadBase|Buffer = undefined, 
      asOf:BN = UnixNow()
  ):Promise<UnsignedTx> => {
    let from:Array<Buffer> = this._cleanAddressArray(fromAddresses, "buildCreateAssetTx").map(a => bintools.stringToAddress(a));

    if( memo instanceof PayloadBase) {
      memo = memo.getPayload();
    }

    /* istanbul ignore next */
    if(symbol.length > AVMConstants.SYMBOLMAXLEN){
        /* istanbul ignore next */
        throw new Error("Error - AVMAPI.buildCreateAssetTx: Symbols may not exceed length of " + AVMConstants.SYMBOLMAXLEN);
    }
    /* istanbul ignore next */
    if(name.length > AVMConstants.ASSETNAMELEN) {
      /* istanbul ignore next */
      throw new Error("Error - AVMAPI.buildCreateAssetTx: Names may not exceed length of " + AVMConstants.ASSETNAMELEN);
    }

    const avaxAssetID:Buffer = await this.getAVAXAssetID();
    const builtUnsignedTx:UnsignedTx = utxoset.buildCreateAssetTx(
      this.core.getNetworkID(), 
      bintools.cb58Decode(this.blockchainID), 
      from,
      initialStates,
      name, 
      symbol, 
      denomination, 
      this.getFee(), 
      avaxAssetID,
      memo, asOf
    );

    if(! await this.checkGooseEgg(builtUnsignedTx)) {
      /* istanbul ignore next */
      throw new Error("Failed Goose Egg Check");
    }

    return builtUnsignedTx;
  };

  /**
   * Creates an unsigned transaction. For more granular control, you may create your own
  * [[UnsignedTx]] manually (with their corresponding [[TransferableInput]]s, [[TransferableOutput]]s, and [[TransferOperation]]s).
  * 
  * @param utxoset A set of UTXOs that the transaction is built on
  * @param fromAddresses The addresses being used to send the funds from the UTXOs {@link https://github.com/feross/buffer|Buffer}
  * @param minterSets is a list where each element specifies that threshold of the addresses in minters may together mint more of the asset by signing a minting transaction
  * @param name String for the descriptive name of the asset
  * @param symbol String for the ticker symbol of the asset
  * @param memo Optional contains arbitrary bytes, up to 256 bytes
  * @param asOf Optional. The timestamp to verify the transaction against as a {@link https://github.com/indutny/bn.js/|BN}
  * @param locktime Optional. The locktime field created in the resulting mint output
  * 
  * ```js
  * Example minterSets:
  * [
  *      {
  *          "minters":[
  *              "X-avax1ghstjukrtw8935lryqtnh643xe9a94u3tc75c7"
  *          ],
  *          "threshold": 1
  *      },
  *      {
  *          "minters": [
  *              "X-avax1yell3e4nln0m39cfpdhgqprsd87jkh4qnakklx",
  *              "X-avax1k4nr26c80jaquzm9369j5a4shmwcjn0vmemcjz",
  *              "X-avax1ztkzsrjnkn0cek5ryvhqswdtcg23nhge3nnr5e"
  *          ],
  *          "threshold": 2
  *      }
  * ]
  * ```
  * 
  * @returns An unsigned transaction ([[UnsignedTx]]) which contains a [[CreateAssetTx]].
  * 
  */
  buildCreateNFTAssetTx = async (
    utxoset:UTXOSet, 
    fromAddresses:Array<string> | Array<Buffer>, 
    minterSets:MinterSet[], 
    name:string, 
    symbol:string, 
    memo:PayloadBase|Buffer = undefined, asOf:BN = UnixNow(), locktime:BN = new BN(0)
  ): Promise<UnsignedTx> => {
    let from:Array<Buffer> = this._cleanAddressArray(fromAddresses, "buildCreateNFTAssetTx").map(a => bintools.stringToAddress(a));
    
    if( memo instanceof PayloadBase) {
      memo = memo.getPayload();
    }

    if(name.length > AVMConstants.ASSETNAMELEN) {
      /* istanbul ignore next */
        throw new Error("Error - AVMAPI.buildCreateNFTAssetTx: Names may not exceed length of " + AVMConstants.ASSETNAMELEN);
    }
    if(symbol.length > AVMConstants.SYMBOLMAXLEN){
      /* istanbul ignore next */
        throw new Error("Error - AVMAPI.buildCreateNFTAssetTx: Symbols may not exceed length of " + AVMConstants.SYMBOLMAXLEN);
    }
    let avaxAssetID:Buffer = await this.getAVAXAssetID();
    const builtUnsignedTx:UnsignedTx = utxoset.buildCreateNFTAssetTx(
        this.core.getNetworkID(), 
        bintools.cb58Decode(this.blockchainID),
        from,
        minterSets,
        name, 
        symbol,
        this.getFee(), 
        avaxAssetID,
        memo, asOf, locktime
    );
    if(! await this.checkGooseEgg(builtUnsignedTx)) {
      /* istanbul ignore next */
      throw new Error("Failed Goose Egg Check");
    }
    return builtUnsignedTx;
  }

  /**
  * Creates an unsigned transaction. For more granular control, you may create your own
  * [[UnsignedTx]] manually (with their corresponding [[TransferableInput]]s, [[TransferableOutput]]s, and [[TransferOperation]]s).
  * 
  * @param utxoset  A set of UTXOs that the transaction is built on
  * @param toAddresses The addresses to send the nft output
  * @param fromAddresses The addresses being used to send the NFT from the utxoID provided
  * @param utxoid A base58 utxoID or an array of base58 utxoIDs for the nft mint output this transaction is sending
  * @param groupID Optional. The group this NFT is issued to.
  * @param payload Optional. Data for NFT Payload as either a [[PayloadBase]] or a {@link https://github.com/feross/buffer|Buffer}
  * @param memo Optional contains arbitrary bytes, up to 256 bytes
  * @param asOf Optional. The timestamp to verify the transaction against as a {@link https://github.com/indutny/bn.js/|BN}
  * @param locktime Optional. The locktime field created in the resulting mint output
  * @param threshold Optional. The number of signatures required to spend the funds in the resultant UTXO
  * 
  * 
  * @returns An unsigned transaction ([[UnsignedTx]]) which contains an [[OperationTx]].
  * 
  */
  buildCreateNFTMintTx = async (
    utxoset:UTXOSet,  
    toAddresses:Array<string>|Array<Buffer>, 
    fromAddresses:Array<string>|Array<Buffer>, 
    utxoid:string|Array<string>,
    groupID:number = 0, 
    payload:PayloadBase|Buffer = undefined, 
    memo:PayloadBase|Buffer = undefined, asOf:BN = UnixNow(), locktime:BN = new BN(0), threshold:number = 1
  ): Promise<any> => {
    let to:Array<Buffer> = this._cleanAddressArray(toAddresses, "buildCreateNFTMintTx").map(a => bintools.stringToAddress(a));
    let from:Array<Buffer> = this._cleanAddressArray(fromAddresses, "buildCreateNFTMintTx").map(a => bintools.stringToAddress(a));
    
    if( memo instanceof PayloadBase) {
      memo = memo.getPayload();
    }

    if(payload instanceof PayloadBase){
      payload = payload.getPayload();
    }

    if(typeof utxoid === 'string') {
        utxoid = [utxoid];
    }

    let avaxAssetID:Buffer = await this.getAVAXAssetID();

    const builtUnsignedTx:UnsignedTx = utxoset.buildCreateNFTMintTx(
        this.core.getNetworkID(),
        bintools.cb58Decode(this.blockchainID),
        to,
        from,
        utxoid,
        groupID,
        payload,
        this.getFee(),
        avaxAssetID,
        memo, asOf, locktime, threshold
    );
    if(! await this.checkGooseEgg(builtUnsignedTx)) {
      /* istanbul ignore next */
      throw new Error("Failed Goose Egg Check");
    }
    return builtUnsignedTx;
  }

  /**
   * Helper function which takes an unsigned transaction and signs it, returning the resulting [[Tx]].
  *
  * @param utx The unsigned transaction of type [[UnsignedTx]]
  *
  * @returns A signed transaction of type [[Tx]]
  */
  signTx = (utx:UnsignedTx):Tx => utx.sign(this.keychain);

  /**
   * Calls the node's issueTx method from the API and returns the resulting transaction ID as a string.
   *
   * @param tx A string, {@link https://github.com/feross/buffer|Buffer}, or [[Tx]] representing a transaction
   *
   * @returns A Promise<string> representing the transaction ID of the posted transaction.
   */
  issueTx = async (tx:string | Buffer | Tx):Promise<string> => {
    let Transaction = '';
    if (typeof tx === 'string') {
      Transaction = tx;
    } else if (tx instanceof Buffer) {
      const txobj:Tx = new Tx();
      txobj.fromBuffer(tx);
      Transaction = txobj.toString();
    } else if (tx instanceof Tx) {
      Transaction = tx.toString();
    } else {
      /* istanbul ignore next */
      throw new Error('Error - avm.issueTx: provided tx is not expected type of string, Buffer, or Tx');
    }
    const params:any = {
      tx: Transaction.toString(),
    };
    return this.callMethod('avm.issueTx', params).then((response:RequestResponseData) => response.data.result.txID);
  };

  /**
   * Sends an amount of assetID to the specified address from a list of owned of addresses.
   *
   * @param username The user that owns the private keys associated with the `from` addresses
   * @param password The password unlocking the user
   * @param assetID The assetID of the asset to send
   * @param amount The amount of the asset to be sent
   * @param to The address of the recipient
   * @param from An array of addresses managed by the node's keystore for this blockchain which will fund this transaction
   *
   * @returns Promise for the string representing the transaction's ID.
   */
  send = async (username:string, password:string, assetID:string | Buffer, amount:number | BN, to:string, from:Array<string> | Array<Buffer>):Promise<string> => {
    let asset:string;
    let amnt:BN;

    if (typeof this.parseAddress(to) === 'undefined') {
      /* istanbul ignore next */
      throw new Error(`Error - AVMAPI.sen: Invalid address format ${to}`);
    }

    from = this._cleanAddressArray(from, 'send');

    if (typeof assetID !== 'string') {
      asset = bintools.cb58Encode(assetID);
    } else {
      asset = assetID;
    }
    if (typeof amount === 'number') {
      amnt = new BN(amount);
    } else {
      amnt = amount;
    }

    const params:any = {
      username,
      password,
      assetID: asset,
      amount: amnt.toString(10),
      to,
      from,
    };
    return this.callMethod('avm.send', params).then((response:RequestResponseData) => response.data.result.txID);
  };

  /**
   * Given a JSON representation of this Virtual Machine’s genesis state, create the byte representation of that state.
   *
   * @param genesisData The blockchain's genesis data object
   *
   * @returns Promise of a string of bytes
   */
  buildGenesis = async (genesisData:object):Promise<string> => {
    const params:any = {
      genesisData,
    };
    return this.callMethod('avm.buildGenesis', params).then((response:RequestResponseData) => {
      const r = response.data.result.bytes;
      return r;
    });
  };

  /**
   * @ignore
   */
  protected _cleanAddressArray(addresses:Array<string> | Array<Buffer>, caller:string):Array<string> {
    const addrs:Array<string> = [];
    const chainid:string = this.getBlockchainAlias() ? this.getBlockchainAlias() : this.getBlockchainID();
    if (addresses && addresses.length > 0) {
      for (let i = 0; i < addresses.length; i++) {
        if (typeof addresses[i] === 'string') {
          if (typeof this.parseAddress(addresses[i] as string) === 'undefined') {
            /* istanbul ignore next */
            throw new Error(`Error - AVMAPI.${caller}: Invalid address format ${addresses[i]}`);
          }
          addrs.push(addresses[i] as string);
        } else {
          addrs.push(bintools.addressToString(this.core.getHRP(), chainid, addresses[i] as Buffer));
        }
      }
    }
    return addrs;
  }

  /**
   * This class should not be instantiated directly. Instead use the [[Avalanche.addAPI]] method.
   *
   * @param core A reference to the Avalanche class
   * @param baseurl Defaults to the string "/ext/bc/X" as the path to blockchain's baseurl
   */
  constructor(core:AvalancheCore, baseurl:string = '/ext/bc/X', blockchainID:string = '') {
    super(core, baseurl);
    this.blockchainID = blockchainID;
    const netid:number = core.getNetworkID();
    if (netid in Defaults.network && blockchainID in Defaults.network[netid]) {
      const { alias } = Defaults.network[netid][blockchainID];
      this.keychain = new AVMKeyChain(this.core.getHRP(), alias);
    } else {
      this.keychain = new AVMKeyChain(this.core.getHRP(), blockchainID);
    }
  }
}
