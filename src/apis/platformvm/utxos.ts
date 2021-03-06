/**
 * @packageDocumentation
 * @module API-PlatformVM-UTXOs
 */
import { Buffer } from 'buffer/';
import BinTools from '../../utils/bintools';
import BN from "bn.js";
import { AmountOutput, SelectOutputClass, TransferableOutput } from './outputs';
import { SecpInput, TransferableInput } from './inputs';
import { UnixNow } from '../../utils/helperfunctions';
import { StandardUTXO, StandardUTXOSet } from '../../common/utxos';
import { PlatformVMConstants } from './constants';
import { UnsignedTx } from './tx';
import { ExportTx } from '../platformvm/exporttx';
import { PlatformChainID, DefaultNetworkID } from '../../utils/constants';
import { ImportTx } from '../platformvm/importtx';
import { BaseTx } from '../platformvm/basetx';
import { StandardAssetAmountDestination, AssetAmount } from '../../common/assetamount';
import { Output } from '../../common/output';
import { AddDelegatorTx, AddSubnetValidatorTx, AddValidatorTx } from './validationtx';

/**
 * @ignore
 */
const bintools = BinTools.getInstance();

/**
 * Class for representing a single UTXO.
 */
export class UTXO extends StandardUTXO {

  fromBuffer(bytes:Buffer, offset:number = 0):number {
    this.codecid = bintools.copyFrom(bytes, offset, offset + 2);
    offset += 2;
    this.txid = bintools.copyFrom(bytes, offset, offset + 32);
    offset += 32;
    this.outputidx = bintools.copyFrom(bytes, offset, offset + 4);
    offset += 4;
    this.assetid = bintools.copyFrom(bytes, offset, offset + 32);
    offset += 32;
    const outputid:number = bintools.copyFrom(bytes, offset, offset + 4).readUInt32BE(0);
    offset += 4;
    this.output = SelectOutputClass(outputid);
    return this.output.fromBuffer(bytes, offset);
  }

  /**
   * Takes a base-58 string containing a [[UTXO]], parses it, populates the class, and returns the length of the StandardUTXO in bytes.
   *
   * @param serialized A base-58 string containing a raw [[UTXO]]
   *
   * @returns The length of the raw [[UTXO]]
   *
   * @remarks
   * unlike most fromStrings, it expects the string to be serialized in cb58 format
   */
  fromString(serialized:string):number {
      /* istanbul ignore next */
      return this.fromBuffer(bintools.cb58Decode(serialized));
  }

  /**
   * Returns a base-58 representation of the [[UTXO]].
   *
   * @remarks
   * unlike most toStrings, this returns in cb58 serialization format
   */
  toString():string {
    /* istanbul ignore next */
    return bintools.cb58Encode(this.toBuffer());
  }

  clone():this {
    const utxo:UTXO = new UTXO();
    utxo.fromBuffer(this.toBuffer());
    return utxo as this;
  }

  create(
    codecID:number = PlatformVMConstants.LATESTCODEC, 
    txid:Buffer = undefined,
    outputidx:Buffer | number = undefined,
    assetid:Buffer = undefined,
    output:Output = undefined):this 
  {
    return new UTXO(codecID, txid, outputidx, assetid, output) as this;
  }

}

export class AssetAmountDestination extends StandardAssetAmountDestination<TransferableOutput, TransferableInput> {}

/**
 * Class representing a set of [[UTXO]]s.
 */
export class UTXOSet extends StandardUTXOSet<UTXO>{

  parseUTXO(utxo:UTXO | string):UTXO {
    const utxovar:UTXO = new UTXO();
    // force a copy
    if (typeof utxo === 'string') {
      utxovar.fromBuffer(bintools.cb58Decode(utxo));
    } else if (utxo instanceof StandardUTXO) {
      utxovar.fromBuffer(utxo.toBuffer()); // forces a copy
    } else {
      /* istanbul ignore next */
      throw new Error(`Error - UTXO.parseUTXO: utxo parameter is not a UTXO or string: ${utxo}`);
    }
    return utxovar
  }

  create(...args:any[]):this{
    return new UTXOSet() as this;
  }

  clone():this {
    const newset:UTXOSet = this.create();
    const allUTXOs:Array<UTXO> = this.getAllUTXOs();
    newset.addArray(allUTXOs)
    return newset as this;
  }

  _feeCheck(fee:BN, feeAssetID:Buffer):boolean {
    return (typeof fee !== "undefined" && 
    typeof feeAssetID !== "undefined" &&
    fee.gt(new BN(0)) && feeAssetID instanceof Buffer);
  }

  getMinimumSpendable = (aad:AssetAmountDestination, asOf:BN = UnixNow(), locktime:BN = new BN(0), threshold:number = 1):Error => {
    const utxoArray:Array<UTXO> = this.getAllUTXOs();
    const outids:object = {};
    for(let i = 0; i < utxoArray.length && !aad.canComplete(); i++) {
      const u:UTXO = utxoArray[i];
      const assetKey:string = u.getAssetID().toString("hex");
      const fromAddresses:Array<Buffer> = aad.getSenders();
      if(u.getOutput() instanceof AmountOutput && aad.assetExists(assetKey) && u.getOutput().meetsThreshold(fromAddresses, asOf)) {
        const am:AssetAmount = aad.getAssetAmount(assetKey);
        if(!am.isFinished()){
          const uout:AmountOutput = u.getOutput() as AmountOutput;
          outids[assetKey] = uout.getOutputID();
          const amount = uout.getAmount();
          am.spendAmount(amount);
          const txid:Buffer = u.getTxID();
          const outputidx:Buffer = u.getOutputIdx();
          const input:SecpInput = new SecpInput(amount);
          const xferin:TransferableInput = new TransferableInput(txid, outputidx, u.getAssetID(), input);
          const spenders:Array<Buffer> = uout.getSpenders(fromAddresses, asOf);
          for (let j = 0; j < spenders.length; j++) {
            const idx:number = uout.getAddressIdx(spenders[j]);
            if (idx === -1) {
              /* istanbul ignore next */
              throw new Error('Error - UTXOSet.buildBaseTx: no such '
              + `address in output: ${spenders[j]}`);
            }
            xferin.getInput().addSignatureIdx(idx, spenders[j]);
          }
          aad.addInput(xferin);
        } else if(aad.assetExists(assetKey) && !(u.getOutput() instanceof AmountOutput)){
          /**
           * Leaving the below lines, not simply for posterity, but for clarification.
           * AssetIDs may have mixed OutputTypes. 
           * Some of those OutputTypes may implement AmountOutput.
           * Others may not.
           * Simply continue in this condition.
           */
          /*return new Error('Error - UTXOSet.getMinimumSpendable: outputID does not '
            + `implement AmountOutput: ${u.getOutput().getOutputID}`);*/
            continue;
        }
      }
    }
    if(!aad.canComplete()) {
      return new Error('Error - UTXOSet.getMinimumSpendable: insufficient '
      + 'funds to create the transaction');
    }
    const amounts:Array<AssetAmount> = aad.getAmounts();
    const zero:BN = new BN(0);
    for(let i = 0; i < amounts.length; i++) {
      const assetKey:string = amounts[i].getAssetIDString();
      const amount:BN = amounts[i].getAmount();
      if (amount.gt(zero)) {
        const spendout:AmountOutput = SelectOutputClass(outids[assetKey],
          amount, aad.getDestinations(), locktime, threshold) as AmountOutput;
        const xferout:TransferableOutput = new TransferableOutput(amounts[i].getAssetID(), spendout);
        aad.addOutput(xferout);
      }
      const change:BN = amounts[i].getChange();
      if (change.gt(zero)) {
        const changeout:AmountOutput = SelectOutputClass(outids[assetKey],
          change, aad.getChangeAddresses()) as AmountOutput;
        const chgxferout:TransferableOutput = new TransferableOutput(amounts[i].getAssetID(), changeout);
        aad.addChange(chgxferout);
      }
    }
    return undefined;
  }

  /**
   * Creates an [[UnsignedTx]] wrapping a [[BaseTx]]. For more granular control, you may create your own
   * [[UnsignedTx]] wrapping a [[BaseTx]] manually (with their corresponding [[TransferableInput]]s and [[TransferableOutput]]s).
   *
   * @param networkid The number representing NetworkID of the node
   * @param blockchainid The {@link https://github.com/feross/buffer|Buffer} representing the BlockchainID for the transaction
   * @param amount The amount of the asset to be spent in its smallest denomination, represented as {@link https://github.com/indutny/bn.js/|BN}.
   * @param assetID {@link https://github.com/feross/buffer|Buffer} of the asset ID for the UTXO
   * @param toAddresses The addresses to send the funds
   * @param fromAddresses The addresses being used to send the funds from the UTXOs {@link https://github.com/feross/buffer|Buffer}
   * @param changeAddresses Optional. The addresses that can spend the change remaining from the spent UTXOs. Default: toAddresses
   * @param fee Optional. The amount of fees to burn in its smallest denomination, represented as {@link https://github.com/indutny/bn.js/|BN}
   * @param feeAssetID Optional. The assetID of the fees being burned. Default: assetID
   * @param memo Optional. Contains arbitrary data, up to 256 bytes
   * @param asOf Optional. The timestamp to verify the transaction against as a {@link https://github.com/indutny/bn.js/|BN}
   * @param locktime Optional. The locktime field created in the resulting outputs
   * @param threshold Optional. The number of signatures required to spend the funds in the resultant UTXO
   * 
   * @returns An unsigned transaction created from the passed in parameters.
   *
   */
  buildBaseTx = (
    networkid:number,
    blockchainid:Buffer,
    amount:BN,
    assetID:Buffer,
    toAddresses:Array<Buffer>,
    fromAddresses:Array<Buffer>,
    changeAddresses:Array<Buffer> = undefined,
    fee:BN = undefined,
    feeAssetID:Buffer = undefined,
    memo:Buffer = undefined,
    asOf:BN = UnixNow(),
    locktime:BN = new BN(0),
    threshold:number = 1
  ):UnsignedTx => {

    if(threshold > toAddresses.length) {
      /* istanbul ignore next */
      throw new Error(`Error - UTXOSet.buildBaseTx: threshold is greater than number of addresses`);
    }

    if(typeof changeAddresses === "undefined") {
      changeAddresses = toAddresses;
    }

    if(typeof feeAssetID === "undefined") {
      feeAssetID = assetID;
    }

    const zero:BN = new BN(0);
    
    if (amount.eq(zero)) {
      return undefined;
    }

    const aad:AssetAmountDestination = new AssetAmountDestination(toAddresses, fromAddresses, changeAddresses);
    if(assetID.toString("hex") === feeAssetID.toString("hex")){
      aad.addAssetAmount(assetID, amount, fee);
    } else {
      aad.addAssetAmount(assetID, amount, zero);
      if(this._feeCheck(fee, feeAssetID)) {
        aad.addAssetAmount(feeAssetID, zero, fee);
      }
    }

    let ins:Array<TransferableInput> = [];
    let outs:Array<TransferableOutput> = [];
    
    const success:Error = this.getMinimumSpendable(aad, asOf, locktime, threshold);
    if(typeof success === "undefined") {
      ins = aad.getInputs();
      outs = aad.getAllOutputs();
    } else {
      throw success;
    }

    const baseTx:BaseTx = new BaseTx(networkid, blockchainid, outs, ins, memo);
    return new UnsignedTx(baseTx);

  };


  /**
    * Creates an unsigned ImportTx transaction.
    *
    * @param networkid The number representing NetworkID of the node
    * @param blockchainid The {@link https://github.com/feross/buffer|Buffer} representing the BlockchainID for the transaction
    * @param fromAddresses An array for {@link https://github.com/feross/buffer|Buffer} who owns the AVAX
    * @param importIns An array of [[TransferableInput]]s being imported
    * @param sourceChain A {@link https://github.com/feross/buffer|Buffer} for the chainid where the imports are coming from.
    * @param fee Optional. The amount of fees to burn in its smallest denomination, represented as {@link https://github.com/indutny/bn.js/|BN}
    * @param feeAssetID Optional. The assetID of the fees being burned. 
    * @param memo Optional contains arbitrary bytes, up to 256 bytes
    * @param asOf Optional. The timestamp to verify the transaction against as a {@link https://github.com/indutny/bn.js/|BN}
    * @returns An unsigned transaction created from the passed in parameters.
    *
    */
   buildImportTx = (
    networkid:number, 
    blockchainid:Buffer,
    fromAddresses:Array<Buffer>,
    importIns:Array<TransferableInput>,
    destinationChain:Buffer = undefined, 
    fee:BN = undefined,
    feeAssetID:Buffer = undefined, 
    memo:Buffer = undefined, 
    asOf:BN = UnixNow(),
  ):UnsignedTx => {
    const zero:BN = new BN(0);
    let ins:Array<TransferableInput> = [];
    let outs:Array<TransferableOutput> = [];
    
    // Not implemented: Fees can be paid from importIns
    if(this._feeCheck(fee, feeAssetID)) {
      const aad:AssetAmountDestination = new AssetAmountDestination(fromAddresses, fromAddresses, fromAddresses);
      aad.addAssetAmount(feeAssetID, zero, fee);
      const success:Error = this.getMinimumSpendable(aad, asOf);
      if(typeof success === "undefined") {
        ins = aad.getInputs();
        outs = aad.getAllOutputs();
      } else {
        throw success;
      }
    }

    if(typeof destinationChain === "undefined") {
      destinationChain = bintools.cb58Decode(PlatformChainID);
    }

    const importTx:ImportTx = new ImportTx(networkid, blockchainid, destinationChain, outs, ins, memo, importIns);
    return new UnsignedTx(importTx);
  };

  /**
    * Creates an unsigned ExportTx transaction. 
    *
    * @param networkid The number representing NetworkID of the node
    * @param blockchainid The {@link https://github.com/feross/buffer|Buffer} representing the BlockchainID for the transaction
    * @param amount The amount being exported as a {@link https://github.com/indutny/bn.js/|BN}
    * @param avaxAssetID {@link https://github.com/feross/buffer|Buffer} of the asset ID for AVAX
    * @param toAddresses An array of addresses as {@link https://github.com/feross/buffer|Buffer} who recieves the AVAX
    * @param fromAddresses An array of addresses as {@link https://github.com/feross/buffer|Buffer} who owns the AVAX
    * @param changeAddresses An array of addresses as {@link https://github.com/feross/buffer|Buffer} who gets the change leftover of the AVAX
    * @param destinationChain Optional. A {@link https://github.com/feross/buffer|Buffer} for the chainid where to send the asset.
    * @param fee Optional. The amount of fees to burn in its smallest denomination, represented as {@link https://github.com/indutny/bn.js/|BN}
    * @param feeAssetID Optional. The assetID of the fees being burned. 
    * @param memo Optional contains arbitrary bytes, up to 256 bytes
    * @param asOf Optional. The timestamp to verify the transaction against as a {@link https://github.com/indutny/bn.js/|BN}
    * @param locktime Optional. The locktime field created in the resulting outputs
    * @param threshold Optional. The number of signatures required to spend the funds in the resultant UTXO
    * 
    * @returns An unsigned transaction created from the passed in parameters.
    *
    */
   buildExportTx = (
    networkid:number, 
    blockchainid:Buffer,
    amount:BN,
    avaxAssetID:Buffer,
    toAddresses:Array<Buffer>,
    fromAddresses:Array<Buffer>,
    changeAddresses:Array<Buffer> = undefined,
    destinationChain:Buffer = undefined,
    fee:BN = undefined,
    feeAssetID:Buffer = undefined, 
    memo:Buffer = undefined, 
    asOf:BN = UnixNow(),
    locktime:BN = new BN(0), 
    threshold:number = 1,
  ):UnsignedTx => {
    let ins:Array<TransferableInput> = [];
    let outs:Array<TransferableOutput> = [];
    let exportouts:Array<TransferableOutput> = [];
    
    if(typeof changeAddresses === "undefined") {
      changeAddresses = toAddresses;
    }

    const zero:BN = new BN(0);
    
    if (amount.eq(zero)) {
      return undefined;
    }

    if(typeof feeAssetID === "undefined") {
      feeAssetID = avaxAssetID;
    } else if (feeAssetID.toString("hex") !== avaxAssetID.toString("hex")) {
      /* istanbul ignore next */
      throw new Error('Error - UTXOSet.buildExportTx: '
      + `feeAssetID must match avaxAssetID`);
    }

    if(typeof destinationChain === "undefined") {
      destinationChain = bintools.cb58Decode(PlatformChainID);
    }

    const aad:AssetAmountDestination = new AssetAmountDestination(toAddresses, fromAddresses, changeAddresses);
    if(avaxAssetID.toString("hex") === feeAssetID.toString("hex")){
      aad.addAssetAmount(avaxAssetID, amount, fee);
    } else {
      aad.addAssetAmount(avaxAssetID, amount, zero);
      if(this._feeCheck(fee, feeAssetID)){
        aad.addAssetAmount(feeAssetID, zero, fee);
      }
    }

    const success:Error = this.getMinimumSpendable(aad, asOf, locktime, threshold);
    if(typeof success === "undefined") {
      ins = aad.getInputs();
      outs = aad.getChangeOutputs();
      exportouts = aad.getOutputs();
    } else {
      throw success;
    }

    const exportTx:ExportTx = new ExportTx(networkid, blockchainid, destinationChain, outs, ins, memo, exportouts);
    return new UnsignedTx(exportTx);
  };


  /**
  * Class representing an unsigned [[AddSubnetValidatorTx]] transaction.
  *
  * @param networkid Networkid, [[DefaultNetworkID]]
  * @param blockchainid Blockchainid, default undefined
  * @param fromAddresses An array of addresses as {@link https://github.com/feross/buffer|Buffer} who pays the fees in AVAX
  * @param changeAddresses An array of addresses as {@link https://github.com/feross/buffer|Buffer} who gets the change leftover from the fee payment
  * @param nodeID The node ID of the validator being added.
  * @param startTime The Unix time when the validator starts validating the Primary Network.
  * @param endTime The Unix time when the validator stops validating the Primary Network (and staked AVAX is returned).
  * @param weight The amount of weight for this subnet validator.
  * @param fee Optional. The amount of fees to burn in its smallest denomination, represented as {@link https://github.com/indutny/bn.js/|BN}
  * @param feeAssetID Optional. The assetID of the fees being burned. 
  * @param memo Optional contains arbitrary bytes, up to 256 bytes
  * @param asOf Optional. The timestamp to verify the transaction against as a {@link https://github.com/indutny/bn.js/|BN}
  * @param locktime Optional. The locktime field created in the resulting outputs
  * @param threshold Optional. The number of signatures required to spend the funds in the resultant UTXO
  * 
  * @returns An unsigned transaction created from the passed in parameters.
  */
  buildAddSubnetValidatorTx = (
    networkid:number = DefaultNetworkID, 
    blockchainid:Buffer,
    fromAddresses:Array<Buffer>,
    changeAddresses:Array<Buffer>,
    nodeID:Buffer, 
    startTime:BN, 
    endTime:BN,
    weight:BN,
    fee:BN = undefined,
    feeAssetID:Buffer = undefined, 
    memo:Buffer = undefined, 
    asOf:BN = UnixNow()
  ):UnsignedTx => {
    let ins:Array<TransferableInput> = [];
    let outs:Array<TransferableOutput> = [];
    //let stakeOuts:Array<TransferableOutput> = [];
    
    const zero:BN = new BN(0);
    const now:BN = UnixNow();
    if (startTime.lt(now) || endTime.lte(startTime)) {
      throw new Error("UTXOSet.buildAddSubnetValidatorTx -- startTime must be in the future and endTime must come after startTime");
    }

    // Not implemented: Fees can be paid from importIns
    if(this._feeCheck(fee, feeAssetID)) {
      const aad:AssetAmountDestination = new AssetAmountDestination(fromAddresses, fromAddresses, changeAddresses);
      aad.addAssetAmount(feeAssetID, zero, fee);
      const success:Error = this.getMinimumSpendable(aad, asOf);
      if(typeof success === "undefined") {
        ins = aad.getInputs();
        outs = aad.getAllOutputs();
      } else {
        throw success;
      }
    }

    const UTx:AddSubnetValidatorTx = new AddSubnetValidatorTx(networkid, blockchainid, outs, ins, memo, nodeID, startTime, endTime, weight);
    return new UnsignedTx(UTx);
  }

  /**
  * Class representing an unsigned [[AddDelegatorTx]] transaction.
  *
  * @param networkid Networkid, [[DefaultNetworkID]]
  * @param blockchainid Blockchainid, default undefined
  * @param avaxAssetID {@link https://github.com/feross/buffer|Buffer} of the asset ID for AVAX
  * @param fromAddresses An array of addresses as {@link https://github.com/feross/buffer|Buffer} who pays the fees and the stake in AVAX
  * @param changeAddresses An array of addresses as {@link https://github.com/feross/buffer|Buffer} who gets the change leftover from the staking payment
  * @param nodeID The node ID of the validator being added.
  * @param startTime The Unix time when the validator starts validating the Primary Network.
  * @param endTime The Unix time when the validator stops validating the Primary Network (and staked AVAX is returned).
  * @param stakeAmount A {@link https://github.com/indutny/bn.js/|BN} for the amount of stake to be delegated in nAVAX.
  * @param rewardAddress The address the validator reward goes.
  * @param fee Optional. The amount of fees to burn in its smallest denomination, represented as {@link https://github.com/indutny/bn.js/|BN}
  * @param feeAssetID Optional. The assetID of the fees being burned. 
  * @param memo Optional contains arbitrary bytes, up to 256 bytes
  * @param asOf Optional. The timestamp to verify the transaction against as a {@link https://github.com/indutny/bn.js/|BN}
  * 
  * @returns An unsigned transaction created from the passed in parameters.
  */
  buildAddDelegatorTx = (
    networkid:number = DefaultNetworkID, 
    blockchainid:Buffer,
    avaxAssetID:Buffer,
    fromAddresses:Array<Buffer>,
    changeAddresses:Array<Buffer>,
    nodeID:Buffer, 
    startTime:BN,
    endTime:BN,
    stakeAmount:BN,
    rewardAddress:Buffer,
    fee:BN = undefined,
    feeAssetID:Buffer = undefined, 
    memo:Buffer = undefined, 
    asOf:BN = UnixNow(),
  ):UnsignedTx => {
    let ins:Array<TransferableInput> = [];
    let outs:Array<TransferableOutput> = [];
    let stakeOuts:Array<TransferableOutput> = [];
    
    const zero:BN = new BN(0);
    const now:BN = UnixNow();
    if (startTime.lt(now) || endTime.lte(startTime)) {
      throw new Error("UTXOSet.buildAddDelegatorTx -- startTime must be in the future and endTime must come after startTime");
    }

    const aad:AssetAmountDestination = new AssetAmountDestination(fromAddresses, fromAddresses, changeAddresses);
    if(avaxAssetID.toString("hex") === feeAssetID.toString("hex")){
      aad.addAssetAmount(avaxAssetID, stakeAmount, fee);
    } else {
      aad.addAssetAmount(avaxAssetID, stakeAmount, zero);
      if(this._feeCheck(fee, feeAssetID)) {
        aad.addAssetAmount(feeAssetID, zero, fee);
      }
    }

    const success:Error = this.getMinimumSpendable(aad, asOf);
    if(typeof success === "undefined") {
      ins = aad.getInputs();
      outs = aad.getChangeOutputs();
      stakeOuts = aad.getOutputs();
    } else {
      throw success;
    }

    const UTx:AddDelegatorTx = new AddDelegatorTx(networkid, blockchainid, outs, ins, memo, nodeID, startTime, endTime, stakeAmount, stakeOuts, rewardAddress);
    return new UnsignedTx(UTx);
  }

  /**
    * Class representing an unsigned [[AddValidatorTx]] transaction.
    *
    * @param networkid Networkid, [[DefaultNetworkID]]
    * @param blockchainid Blockchainid, default undefined
    * @param avaxAssetID {@link https://github.com/feross/buffer|Buffer} of the asset ID for AVAX
    * @param fromAddresses An array of addresses as {@link https://github.com/feross/buffer|Buffer} who pays the fees and the stake in AVAX
    * @param changeAddresses An array of addresses as {@link https://github.com/feross/buffer|Buffer} who gets the change leftover from the staking payment
    * @param nodeID The node ID of the validator being added.
    * @param startTime The Unix time when the validator starts validating the Primary Network.
    * @param endTime The Unix time when the validator stops validating the Primary Network (and staked AVAX is returned).
    * @param stakeAmount A {@link https://github.com/indutny/bn.js/|BN} for the amount of stake to be delegated in nAVAX.
    * @param rewardAddress The address the validator reward goes.
    * @param delegationFee A number for the percentage of reward to be given to the validator when someone delegates to them. Must be between 0 and 100. 
    * @param fee Optional. The amount of fees to burn in its smallest denomination, represented as {@link https://github.com/indutny/bn.js/|BN}
    * @param feeAssetID Optional. The assetID of the fees being burned. 
    * @param memo Optional contains arbitrary bytes, up to 256 bytes
    * @param asOf Optional. The timestamp to verify the transaction against as a {@link https://github.com/indutny/bn.js/|BN}
    * 
    * @returns An unsigned transaction created from the passed in parameters.
    */
  buildAddValidatorTx = (
    networkid:number = DefaultNetworkID, 
    blockchainid:Buffer,
    avaxAssetID:Buffer,
    fromAddresses:Array<Buffer>,
    changeAddresses:Array<Buffer>,
    nodeID:Buffer, 
    startTime:BN,
    endTime:BN,
    stakeAmount:BN,
    rewardAddress:Buffer,
    delegationFee:number,
    fee:BN = undefined,
    feeAssetID:Buffer = undefined, 
    memo:Buffer = undefined, 
    asOf:BN = UnixNow(),
  ):UnsignedTx => {
    let ins:Array<TransferableInput> = [];
    let outs:Array<TransferableOutput> = [];
    let stakeOuts:Array<TransferableOutput> = [];
    
    const zero:BN = new BN(0);
    const now:BN = UnixNow();
    if (startTime.lt(now) || endTime.lte(startTime)) {
      throw new Error("UTXOSet.buildAddValidatorTx -- startTime must be in the future and endTime must come after startTime");
    }

    if(stakeAmount.lt(PlatformVMConstants.MINSTAKE)) {
      throw new Error("UTXOSet.buildAddValidatorTx -- stake amount must be at least " + PlatformVMConstants.MINSTAKE);
    }

    if(delegationFee > 100 || delegationFee < 0){
      throw new Error("UTXOSet.buildAddValidatorTx -- startTime must be in the range of 0 to 100, inclusively");
    }

    const aad:AssetAmountDestination = new AssetAmountDestination(fromAddresses, fromAddresses, changeAddresses);
    if(avaxAssetID.toString("hex") === feeAssetID.toString("hex")){
      aad.addAssetAmount(avaxAssetID, stakeAmount, fee);
    } else {
      aad.addAssetAmount(avaxAssetID, stakeAmount, zero);
      if(this._feeCheck(fee, feeAssetID)) {
        aad.addAssetAmount(feeAssetID, zero, fee);
      }
    }
    
    const success:Error = this.getMinimumSpendable(aad, asOf);
    if(typeof success === "undefined") {
      ins = aad.getInputs();
      outs = aad.getChangeOutputs();
      stakeOuts = aad.getOutputs();
    } else {
      throw success;
    }

    const UTx:AddValidatorTx = new AddValidatorTx(networkid, blockchainid, outs, ins, memo, nodeID, startTime, endTime, stakeAmount, stakeOuts, rewardAddress, delegationFee);
    return new UnsignedTx(UTx);
  }

}
