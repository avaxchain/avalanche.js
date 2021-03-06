/**
 * @packageDocumentation
 * @module API-PlatformVM
 */
import { Buffer } from 'buffer/';
import BN from 'bn.js';
import AvalancheCore from '../../avalanche';
import { JRPCAPI } from '../../common/jrpcapi';
import { RequestResponseData } from '../../common/apibase';
import BinTools from '../../utils/bintools';
import { PlatformVMKeyChain } from './keychain';
import { Defaults, PlatformChainID } from '../../utils/constants';
import { PlatformVMConstants } from './constants';
import { UnsignedTx, Tx } from './tx';
import { PayloadBase } from '../../utils/payload';
import { UnixNow, NodeIDStringToBuffer } from '../../utils/helperfunctions';
import { UTXOSet } from '../platformvm/utxos';
import { TransferableInput, SecpInput } from '../platformvm/inputs';
import { UTXO } from '../platformvm/utxos';
import { AmountOutput } from '../platformvm/outputs';
import { PersistanceOptions } from '../../utils/persistenceoptions';
import { ExportTx } from './exporttx';
import { AddValidatorTx, AddDelegatorTx } from './validationtx';

/**
 * @ignore
 */
const bintools:BinTools = BinTools.getInstance();

/**
 * Class for interacting with a node's PlatformVMAPI
 *
 * @category RPCAPIs
 *
 * @remarks This extends the [[JRPCAPI]] class. This class should not be directly called. Instead, use the [[Avalanche.addAPI]] function to register this interface with Avalanche.
 */
export class PlatformVMAPI extends JRPCAPI {

  /**
   * @ignore
   */
  protected keychain:PlatformVMKeyChain = new PlatformVMKeyChain('', '');

  protected blockchainID:string = PlatformChainID;

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
      this.blockchainID = PlatformChainID; //default to P-Chain
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
    return bintools.parseAddress(addr, blockchainID, alias, PlatformVMConstants.ADDRESSLENGTH);
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
      const assetID:string = await this.getStakingAssetID();
      this.AVAXAssetID = bintools.cb58Decode(assetID);
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
   * @returns The instance of [[PlatformVMKeyChain]] for this class
   */
  keyChain = ():PlatformVMKeyChain => this.keychain;

  /**
   * @ignore
   */
  newKeyChain = ():PlatformVMKeyChain => {
    // warning, overwrites the old keychain
    const alias = this.getBlockchainAlias();
    if (alias) {
      this.keychain = new PlatformVMKeyChain(this.core.getHRP(), alias);
    } else {
      this.keychain = new PlatformVMKeyChain(this.core.getHRP(), this.blockchainID);
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
    if(fee.lte(PlatformVMConstants.ONEAVAX.mul(new BN(10))) || fee.lte(outputTotal)) {
      return true;
    } else {
      return false;
    }
  }

  /**
   * Retrieves an assetID for a subnet's staking assset.
   *
   * @returns Returns a Promise<string> with cb58 encoded value of the assetID.
   */
  getStakingAssetID = async ():Promise<string> => {
    const params:any = {};
    return this.callMethod('platform.getStakingAssetID', params).then((response:RequestResponseData) => (response.data.result.assetID));
  };

  /**
   * Creates a new blockchain.
   *
   * @param username The username of the Keystore user that controls the new account
   * @param password The password of the Keystore user that controls the new account
   * @param subnetID Optional. Either a {@link https://github.com/feross/buffer|Buffer} or an cb58 serialized string for the SubnetID or its alias.
   * @param vmID The ID of the Virtual Machine the blockchain runs. Can also be an alias of the Virtual Machine.
   * @param FXIDs The ids of the FXs the VM is running.
   * @param name A human-readable name for the new blockchain
   * @param genesis The base 58 (with checksum) representation of the genesis state of the new blockchain. Virtual Machines should have a static API method named buildGenesis that can be used to generate genesisData.
   *
   * @returns Promise for the unsigned transaction to create this blockchain. Must be signed by a sufficient number of the Subnet’s control keys and by the account paying the transaction fee.
   */
  createBlockchain = async (
    username: string,
    password:string,
    subnetID:Buffer | string = undefined,
    vmID:string,
    fxIDs: Array<number>,
    name:string,
    genesis:string,
    )
  :Promise<string> => {
    const params:any = {
      username, 
      password,
      fxIDs,
      vmID,
      name,
      genesisData: genesis,
    };
    if (typeof subnetID === 'string') {
      params.subnetID = subnetID;
    } else if (typeof subnetID !== 'undefined') {
      params.subnetID = bintools.cb58Encode(subnetID);
    }
    return this.callMethod('platform.createBlockchain', params)
      .then((response:RequestResponseData) => response.data.result.txID);
  };

  /**
   * Gets the status of a blockchain.
   *
   * @param blockchainID The blockchainID requesting a status update
   *
   * @returns Promise for a string of one of: "Validating", "Created", "Preferred", "Unknown".
   */
  getBlockchainStatus = async (blockchainID: string):Promise<string> => {
    const params:any = {
      blockchainID,
    };
    return this.callMethod('platform.getBlockchainStatus', params)
      .then((response:RequestResponseData) => response.data.result.status);
  };

  /**
   * Create an address in the node's keystore.
   *
   * @param username The username of the Keystore user that controls the new account
   * @param password The password of the Keystore user that controls the new account
   *
   * @returns Promise for a string of the newly created account address.
   */
  createAddress = async (
    username: string,
    password:string
  )
  :Promise<string> => {
    const params:any = {
      username,
      password,
    };
    return this.callMethod('platform.createAddress', params)
      .then((response:RequestResponseData) => response.data.result.address);
  };

  /**
   * Gets the balance of a particular asset.
   *
   * @param address The address to pull the asset balance from
   *
   * @returns Promise with the balance as a {@link https://github.com/indutny/bn.js/|BN} on the provided address.
   */
  getBalance = async (address:string):Promise<object> => {
    if (typeof this.parseAddress(address) === 'undefined') {
      /* istanbul ignore next */
      throw new Error(`Error - PlatformVMAPI.getBalance: Invalid address format ${address}`);
    }
    const params:any = {
      address
    };
    return  this.callMethod('platform.getBalance', params).then((response:RequestResponseData) => response.data.result);
  };
  
  /**
   * List the addresses controlled by the user.
   *
   * @param username The username of the Keystore user
   * @param password The password of the Keystore user
   *
   * @returns Promise for an array of addresses.
   */
  listAddresses = async (username: string, password:string):Promise<Array<string>> => {
    const params:any = {
      username,
      password,
    };
    return this.callMethod('platform.listAddresses', params)
      .then((response:RequestResponseData) => response.data.result.addresses);
  };

  /**
   * Lists the set of current validators.
   *
   * @param subnetID Optional. Either a {@link https://github.com/feross/buffer|Buffer} or an
   * cb58 serialized string for the SubnetID or its alias.
   *
   * @returns Promise for an array of validators that are currently staking, see: {@link https://docs.avax.network/v1.0/en/api/platform/#platformgetcurrentvalidators|platform.getCurrentValidators documentation}.
   *
   */
  getCurrentValidators = async (subnetID:Buffer | string = undefined):Promise<Array<object>> => {
    const params:any = {};
    if (typeof subnetID === 'string') {
      params.subnetID = subnetID;
    } else if (typeof subnetID !== 'undefined') {
      params.subnetID = bintools.cb58Encode(subnetID);
    }
    return this.callMethod('platform.getCurrentValidators', params)
      .then((response:RequestResponseData) => response.data.result.validators);
  };

  /**
   * Lists the set of pending validators.
   *
   * @param subnetID Optional. Either a {@link https://github.com/feross/buffer|Buffer}
   * or a cb58 serialized string for the SubnetID or its alias.
   *
   * @returns Promise for an array of validators that are pending staking, see: {@link https://docs.avax.network/v1.0/en/api/platform/#platformgetpendingvalidators|platform.getPendingValidators documentation}.
   *
   */
  getPendingValidators = async (subnetID:Buffer | string = undefined):Promise<Array<object>> => {
    const params:any = {};
    if (typeof subnetID === 'string') {
      params.subnetID = subnetID;
    } else if (typeof subnetID !== 'undefined') {
      params.subnetID = bintools.cb58Encode(subnetID);
    }

    return this.callMethod('platform.getPendingValidators', params)
      .then((response:RequestResponseData) => response.data.result.validators);
  };

  /**
   * Samples `Size` validators from the current validator set.
   *
   * @param sampleSize Of the total universe of validators, select this many at random
   * @param subnetID Optional. Either a {@link https://github.com/feross/buffer|Buffer} or an
   * cb58 serialized string for the SubnetID or its alias.
   *
   * @returns Promise for an array of validator's stakingIDs.
   */
  sampleValidators = async (sampleSize:number,
    subnetID:Buffer | string = undefined)
  :Promise<Array<string>> => {
    const params:any = {
      size: sampleSize.toString(),
    };
    if (typeof subnetID === 'string') {
      params.subnetID = subnetID;
    } else if (typeof subnetID !== 'undefined') {
      params.subnetID = bintools.cb58Encode(subnetID);
    }
    return this.callMethod('platform.sampleValidators', params)
      .then((response:RequestResponseData) => response.data.result.validators);
  };

  /**
   * Add a validator to the Primary Network.
   *
   * @param username The username of the Keystore user
   * @param password The password of the Keystore user
   * @param nodeID The node ID of the validator
   * @param startTime Javascript Date object for the start time to validate
   * @param endTime Javascript Date object for the end time to validate
   * @param stakeAmount The amount of nAVAX the validator is staking as
   * a {@link https://github.com/indutny/bn.js/|BN}
   * @param rewardAddress The address the validator reward will go to, if there is one.
   * @param delegationFeeRate Optional. A {@link https://github.com/indutny/bn.js/|BN} for the percent fee this validator 
   * charges when others delegate stake to them. Up to 4 decimal places allowed; additional decimal places are ignored. 
   * Must be between 0 and 100, inclusive. For example, if delegationFeeRate is 1.2345 and someone delegates to this 
   * validator, then when the delegation period is over, 1.2345% of the reward goes to the validator and the rest goes 
   * to the delegator.
   *
   * @returns Promise for a base58 string of the unsigned transaction.
   */
  addValidator = async (
    username:string,
    password:string,
    nodeID:string,
    startTime:Date,
    endTime:Date,
    stakeAmount:BN,
    rewardAddress:string,
    delegationFeeRate:BN = undefined
  )
  :Promise<string> => {
    const params:any = {
      username,
      password,
      nodeID,
      startTime: startTime.getTime() / 1000,
      endTime: endTime.getTime() / 1000,
      stakeAmount: stakeAmount.toString(10),
      rewardAddress,
    };
    if (typeof delegationFeeRate !== 'undefined') {
      params.delegationFeeRate = delegationFeeRate.toString(10);
    }
    return this.callMethod('platform.addValidator', params)
      .then((response:RequestResponseData) => response.data.result.txID);
  };

  /**
   * Add a validator to a Subnet other than the Primary Network. The validator must validate the Primary Network for the entire duration they validate this Subnet.
   *
   * @param username The username of the Keystore user
   * @param password The password of the Keystore user
   * @param nodeID The node ID of the validator
   * @param subnetID Either a {@link https://github.com/feross/buffer|Buffer} or a cb58 serialized string for the SubnetID or its alias.
   * @param startTime Javascript Date object for the start time to validate
   * @param endTime Javascript Date object for the end time to validate
   * @param weight The validator’s weight used for sampling
   *
   * @returns Promise for the unsigned transaction. It must be signed (using sign) by the proper number of the Subnet’s control keys and by the key of the account paying the transaction fee before it can be issued.
   */
  addSubnetValidator = async (
    username:string,
    password:string,
    nodeID:string,
    subnetID:Buffer | string,
    startTime:Date,
    endTime:Date,
    weight:number
    )
  :Promise<string> => {
    const params:any = {
      username,
      password,
      nodeID,
      startTime: startTime.getTime() / 1000,
      endTime: endTime.getTime() / 1000,
      weight
    };
    if (typeof subnetID === 'string') {
      params.subnetID = subnetID;
    } else if (typeof subnetID !== 'undefined') {
      params.subnetID = bintools.cb58Encode(subnetID);
    }
    return this.callMethod('platform.addSubnetValidator', params)
      .then((response:RequestResponseData) => response.data.result.txID);
  };

  /**
   * Add a delegator to the Primary Network.
   *
   * @param username The username of the Keystore user
   * @param password The password of the Keystore user
   * @param nodeID The node ID of the delegatee
   * @param startTime Javascript Date object for when the delegator starts delegating
   * @param endTime Javascript Date object for when the delegator starts delegating
   * @param stakeAmount The amount of nAVAX the delegator is staking as
   * a {@link https://github.com/indutny/bn.js/|BN}
   * @param rewardAddress The address of the account the staked AVAX and validation reward
   * (if applicable) are sent to at endTime
   *
   * @returns Promise for an array of validator's stakingIDs.
   */
  addDelegator = async (
    username:string,
    password:string,
    nodeID:string,
    startTime:Date,
    endTime:Date,
    stakeAmount:BN,
    rewardAddress:string)
  :Promise<string> => {
    const params:any = {
      username,
      password,
      nodeID,
      startTime: startTime.getTime() / 1000,
      endTime: endTime.getTime() / 1000,
      stakeAmount: stakeAmount.toString(10),
      rewardAddress,
    };
    return this.callMethod('platform.addDelegator', params)
      .then((response:RequestResponseData) => response.data.result.txID);
  };

  /**
   * Create an unsigned transaction to create a new Subnet. The unsigned transaction must be
   * signed with the key of the account paying the transaction fee. The Subnet’s ID is the ID of the transaction that creates it (ie the response from issueTx when issuing the signed transaction).
   *
   * @param username The username of the Keystore user
   * @param password The password of the Keystore user
   * @param controlKeys Array of platform addresses as strings
   * @param threshold To add a validator to this Subnet, a transaction must have threshold
   * signatures, where each signature is from a key whose address is an element of `controlKeys`
   *
   * @returns Promise for a string with the unsigned transaction encoded as base58.
   */
  createSubnet = async (
    username: string, 
    password:string,
    controlKeys:Array<string>, 
    threshold:number
  )
  :Promise<string> => {
    const params:any = {
      username,
      password,
      controlKeys,
      threshold
    };
    return this.callMethod('platform.createSubnet', params)
      .then((response:RequestResponseData) => response.data.result.txID);
  };

  /**
   * Get the Subnet that validates a given blockchain.
   *
   * @param blockchainID Either a {@link https://github.com/feross/buffer|Buffer} or a cb58 
   * encoded string for the blockchainID or its alias.
   *
   * @returns Promise for a string of the subnetID that validates the blockchain.
   */
  validatedBy = async (blockchainID:string):Promise<string> => {
    const params:any = {
      blockchainID,
    };
    return this.callMethod('platform.validatedBy', params)
      .then((response:RequestResponseData) => response.data.result.subnetID);
  };

  /**
   * Get the IDs of the blockchains a Subnet validates.
   *
   * @param subnetID Either a {@link https://github.com/feross/buffer|Buffer} or an AVAX
   * serialized string for the SubnetID or its alias.
   *
   * @returns Promise for an array of blockchainIDs the subnet validates.
   */
  validates = async (subnetID:Buffer | string):Promise<Array<string>> => {
    const params:any = {
      subnetID,
    };
    if (typeof subnetID === 'string') {
      params.subnetID = subnetID;
    } else if (typeof subnetID !== 'undefined') {
      params.subnetID = bintools.cb58Encode(subnetID);
    }
    return this.callMethod('platform.validates', params)
      .then((response:RequestResponseData) => response.data.result.blockchainIDs);
  };

  /**
   * Get all the blockchains that exist (excluding the P-Chain).
   *
   * @returns Promise for an array of objects containing fields "id", "subnetID", and "vmID".
   */
  getBlockchains = async ():Promise<Array<object>> => {
    const params:any = {};
    return this.callMethod('platform.getBlockchains', params)
      .then((response:RequestResponseData) => response.data.result.blockchains);
  };

  /**
   * Send AVAX from an account on the P-Chain to an address on the X-Chain. This transaction
   * must be signed with the key of the account that the AVAX is sent from and which pays the
   * transaction fee. After issuing this transaction, you must call the X-Chain’s importAVAX
   * method to complete the transfer.
   *
   * @param username The Keystore user that controls the account specified in `to`
   * @param password The password of the Keystore user
   * @param to The address on the X-Chain to send the AVAX to. Do not include X- in the address
   * @param amount Amount of AVAX to export as a {@link https://github.com/indutny/bn.js/|BN}
   *
   * @returns Promise for an unsigned transaction to be signed by the account the the AVAX is
   * sent from and pays the transaction fee.
   */
  exportAVAX = async (username: string, password:string, amount:BN, to:string,):Promise<string> => {
    const params:any = {
      username,
      password,
      to,
      amount: amount.toString(10)
    };
    return this.callMethod('platform.exportAVAX', params)
      .then((response:RequestResponseData) => response.data.result.txID);
  };

  /**
   * Send AVAX from an account on the P-Chain to an address on the X-Chain. This transaction
   * must be signed with the key of the account that the AVAX is sent from and which pays
   * the transaction fee. After issuing this transaction, you must call the X-Chain’s
   * importAVAX method to complete the transfer.
   *
   * @param username The Keystore user that controls the account specified in `to`
   * @param password The password of the Keystore user
   * @param to The ID of the account the AVAX is sent to. This must be the same as the to
   * argument in the corresponding call to the X-Chain’s exportAVAX
   * @param sourceChain The chainID where the funds are coming from.
   *
   * @returns Promise for a string for the transaction, which should be sent to the network
   * by calling issueTx.
   */
  importAVAX = async (username: string, password:string, to:string, sourceChain:string)
  :Promise<string> => {
    const params:any = {
      to,
      sourceChain,
      username,
      password,
    };
    return this.callMethod('platform.importAVAX', params)
      .then((response:RequestResponseData) => response.data.result.txID);
  };

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
      throw new Error('Error - platform.issueTx: provided tx is not expected type of string, Buffer, or Tx');
    }
    const params:any = {
      tx: Transaction.toString(),
    };
    return this.callMethod('platform.issueTx', params).then((response:RequestResponseData) => response.data.result.txID);
  };

  /**
   * Get all the subnets that exist.
   *
   * @param ids IDs of the subnets to retrieve information about. If omitted, gets all subnets
   * 
   * @returns Promise for an array of objects containing fields "id",
   * "controlKeys", and "threshold".
   */
  getSubnets = async (ids:Array<string> = undefined):Promise<Array<object>> => {
    const params:any = {};
    if(typeof ids !== undefined){
      params.ids = ids;
    }
    return this.callMethod('platform.getSubnets', params)
      .then((response:RequestResponseData) => response.data.result.subnets);
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
    const params:any = {
      username,
      password,
      address,
    };
    return this.callMethod('platform.exportKey', params)
      .then((response:RequestResponseData) => response.data.result.privateKey);
  };

  /**
   * Give a user control over an address by providing the private key that controls the address.
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
    return this.callMethod('platform.importKey', params)
      .then((response:RequestResponseData) => response.data.result.address);
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
    return this.callMethod('platform.getTx', params).then((response:RequestResponseData) => response.data.result.tx);
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
    return this.callMethod('platform.getTxStatus', params).then((response:RequestResponseData) => response.data.result.status);
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
      limit
    };
    if(typeof startIndex !== "undefined"){
      params.startIndex = startIndex;
    }
    return this.callMethod('platform.getUTXOs', params).then((response:RequestResponseData) => {
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
      throw new Error("Error - PlatformVMAPI.buildImportTx: Invalid destinationChain type: " + (typeof sourceChain) );
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
      throw new Error("Error - PlatformVMAPI.buildExportTx: Invalid destinationChain type: " + (typeof destinationChain) );
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
  * Helper function which creates an unsigned [[AddSubnetValidatorTx]]. For more granular control, you may create your own
  * [[UnsignedTx]] manually and import the [[AddSubnetValidatorTx]] class directly.
  *
  * @param utxoset A set of UTXOs that the transaction is built on.
  * @param fromAddresses An array of addresses as {@link https://github.com/feross/buffer|Buffer} who pays the fees in AVAX
  * @param changeAddresses An array of addresses as {@link https://github.com/feross/buffer|Buffer} who gets the change leftover from the fee payment
  * @param nodeID The node ID of the validator being added.
  * @param startTime The Unix time when the validator starts validating the Primary Network.
  * @param endTime The Unix time when the validator stops validating the Primary Network (and staked AVAX is returned).
  * @param weight The amount of weight for this subnet validator.
  * @param memo Optional contains arbitrary bytes, up to 256 bytes
  * @param asOf Optional. The timestamp to verify the transaction against as a {@link https://github.com/indutny/bn.js/|BN}
  *  
  * @returns An unsigned transaction created from the passed in parameters.
  */
  buildAddSubnetValidatorTx = async (
    utxoset:UTXOSet, 
    fromAddresses:Array<string>,
    changeAddresses:Array<string>,
    nodeID:string, 
    startTime:BN, 
    endTime:BN,
    weight:BN,
    memo:PayloadBase|Buffer = undefined, 
    asOf:BN = UnixNow()
  ):Promise<UnsignedTx> => {
    const from:Array<Buffer> = this._cleanAddressArray(fromAddresses, 'buildAddSubnetValidatorTx').map((a) => bintools.stringToAddress(a));
    const change:Array<Buffer> = this._cleanAddressArray(changeAddresses, 'buildAddSubnetValidatorTx').map((a) => bintools.stringToAddress(a));

    if( memo instanceof PayloadBase) {
      memo = memo.getPayload();
    }

    const avaxAssetID:Buffer = await this.getAVAXAssetID();
    
    const now:BN = UnixNow();
    if (startTime.lt(now) || endTime.lte(startTime)) {
      throw new Error("PlatformVMAPI.buildAddSubnetValidatorTx -- startTime must be in the future and endTime must come after startTime");
    }

    const builtUnsignedTx:UnsignedTx = utxoset.buildAddSubnetValidatorTx(
      this.core.getNetworkID(), 
      bintools.cb58Decode(this.blockchainID), 
      from,
      change,
      NodeIDStringToBuffer(nodeID),
      startTime, endTime,
      weight, 
      this.getFee(), 
      avaxAssetID,
      memo, asOf
    );

    if(! await this.checkGooseEgg(builtUnsignedTx)) {
      /* istanbul ignore next */
      throw new Error("Failed Goose Egg Check");
    }

    return builtUnsignedTx;
  }

  /**
  * Helper function which creates an unsigned [[AddDelegatorTx]]. For more granular control, you may create your own
  * [[UnsignedTx]] manually and import the [[AddDelegatorTx]] class directly.
  *
  * @param utxoset A set of UTXOs that the transaction is built on
  * @param fromAddresses An array of addresses as {@link https://github.com/feross/buffer|Buffer} who pays the fees in AVAX
  * @param changeAddresses An array of addresses as {@link https://github.com/feross/buffer|Buffer} who gets the change leftover from the fee payment
  * @param nodeID The node ID of the validator being added.
  * @param startTime The Unix time when the validator starts validating the Primary Network.
  * @param endTime The Unix time when the validator stops validating the Primary Network (and staked AVAX is returned).
  * @param stakeAmount The amount being delegated as a {@link https://github.com/indutny/bn.js/|BN}
  * @param rewardAddress The address which will recieve the rewards from the delegated stake.
  * @param memo Optional contains arbitrary bytes, up to 256 bytes
  * @param asOf Optional. The timestamp to verify the transaction against as a {@link https://github.com/indutny/bn.js/|BN}
  *  
  * @returns An unsigned transaction created from the passed in parameters.
  */
  buildAddDelegatorTx = async (
    utxoset:UTXOSet, 
    fromAddresses:Array<string>,
    changeAddresses:Array<string>,
    nodeID:string, 
    startTime:BN, 
    endTime:BN,
    stakeAmount:BN,
    rewardAddress:string,
    memo:PayloadBase|Buffer = undefined, 
    asOf:BN = UnixNow()
  ):Promise<UnsignedTx> => {
    const from:Array<Buffer> = this._cleanAddressArray(fromAddresses, 'buildAddDelegatorTx').map((a) => bintools.stringToAddress(a));
    const change:Array<Buffer> = this._cleanAddressArray(changeAddresses, 'buildAddDelegatorTx').map((a) => bintools.stringToAddress(a));

    if( memo instanceof PayloadBase) {
      memo = memo.getPayload();
    }

    const avaxAssetID:Buffer = await this.getAVAXAssetID();
    
    const now:BN = UnixNow();
    if (startTime.lt(now) || endTime.lte(startTime)) {
      throw new Error("PlatformVMAPI.buildAddDelegatorTx -- startTime must be in the future and endTime must come after startTime");
    }

    const builtUnsignedTx:UnsignedTx = utxoset.buildAddDelegatorTx(
      this.core.getNetworkID(), 
      bintools.cb58Decode(this.blockchainID), 
      avaxAssetID,
      from,
      change,
      NodeIDStringToBuffer(nodeID),
      startTime, endTime,
      stakeAmount,
      bintools.stringToAddress(rewardAddress),
      this.getFee(), 
      avaxAssetID,
      memo, asOf
    );

    if(!await this.checkGooseEgg(builtUnsignedTx)) {
      /* istanbul ignore next */
      throw new Error("Failed Goose Egg Check");
    }

    return builtUnsignedTx;
  }


  /**
  * Helper function which creates an unsigned [[AddValidatorTx]]. For more granular control, you may create your own
  * [[UnsignedTx]] manually and import the [[AddValidatorTx]] class directly.
  *
  * @param utxoset A set of UTXOs that the transaction is built on
  * @param fromAddresses An array of addresses as {@link https://github.com/feross/buffer|Buffer} who pays the fees in AVAX
  * @param changeAddresses An array of addresses as {@link https://github.com/feross/buffer|Buffer} who gets the change leftover from the fee payment
  * @param nodeID The node ID of the validator being added.
  * @param startTime The Unix time when the validator starts validating the Primary Network.
  * @param endTime The Unix time when the validator stops validating the Primary Network (and staked AVAX is returned).
  * @param stakeAmount The amount being delegated as a {@link https://github.com/indutny/bn.js/|BN}
  * @param rewardAddress The address which will recieve the rewards from the delegated stake.
  * @param delegationFee A number for the percentage of reward to be given to the validator when someone delegates to them. Must be between 0 and 100. 
  * @param memo Optional contains arbitrary bytes, up to 256 bytes
  * @param asOf Optional. The timestamp to verify the transaction against as a {@link https://github.com/indutny/bn.js/|BN}
  *  
  * @returns An unsigned transaction created from the passed in parameters.
  */
  buildAddValidatorTx = async (
    utxoset:UTXOSet, 
    fromAddresses:Array<string>,
    changeAddresses:Array<string>,
    nodeID:string, 
    startTime:BN, 
    endTime:BN,
    stakeAmount:BN,
    rewardAddress:string,
    delegationFee:number,
    memo:PayloadBase|Buffer = undefined, 
    asOf:BN = UnixNow()
  ):Promise<UnsignedTx> => {
    const from:Array<Buffer> = this._cleanAddressArray(fromAddresses, 'buildAddValidatorTx').map((a) => bintools.stringToAddress(a));
    const change:Array<Buffer> = this._cleanAddressArray(changeAddresses, 'buildAddValidatorTx').map((a) => bintools.stringToAddress(a));

    if( memo instanceof PayloadBase) {
      memo = memo.getPayload();
    }

    const avaxAssetID:Buffer = await this.getAVAXAssetID();
    
    const now:BN = UnixNow();
    if (startTime.lt(now) || endTime.lte(startTime)) {
      throw new Error("PlatformVMAPI.buildAddValidatorTx -- startTime must be in the future and endTime must come after startTime");
    }

    const builtUnsignedTx:UnsignedTx = utxoset.buildAddValidatorTx(
      this.core.getNetworkID(), 
      bintools.cb58Decode(this.blockchainID), 
      avaxAssetID,
      from,
      change,
      NodeIDStringToBuffer(nodeID),
      startTime, endTime,
      stakeAmount,
      bintools.stringToAddress(rewardAddress),
      delegationFee,
      this.getFee(), 
      avaxAssetID,
      memo, asOf
    );

    if(! await this.checkGooseEgg(builtUnsignedTx)) {
      /* istanbul ignore next */
      throw new Error("Failed Goose Egg Check");
    }

    return builtUnsignedTx;
  }

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
            throw new Error(`Error - PlatformVMAPI.${caller}: Invalid address format ${addresses[i]}`);
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
   * This class should not be instantiated directly.
   * Instead use the [[Avalanche.addAPI]] method.
   *
   * @param core A reference to the Avalanche class
   * @param baseurl Defaults to the string "/ext/P" as the path to blockchain's baseurl
   */
  constructor(core:AvalancheCore, baseurl:string = '/ext/bc/P') { super(core, baseurl); }
}

