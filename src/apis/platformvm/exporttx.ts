/**
 * @packageDocumentation
 * @module API-PlatformVM-ExportTx
 */
import { Buffer } from 'buffer/';
import BinTools from '../../utils/bintools';
import {  PlatformVMConstants } from './constants';
import { TransferableOutput } from './outputs';
import { TransferableInput } from './inputs';
import { BaseTx } from './basetx';
import { DefaultNetworkID } from '../../utils/constants';
import BN from 'bn.js';
import { AmountOutput } from '../platformvm/outputs';

/**
 * @ignore
 */
const bintools = BinTools.getInstance();

/**
 * Class representing an unsigned Export transaction.
 */
export class ExportTx extends BaseTx {
  protected destinationChain:Buffer = Buffer.alloc(32);
  protected numOuts:Buffer = Buffer.alloc(4);
  protected exportOuts:Array<TransferableOutput> = [];

  /**
   * Returns the id of the [[ExportTx]]
   */
  getTxType = ():number => {
    return PlatformVMConstants.EXPORTTX;
  }

  /**
   * Returns an array of [[TransferableOutput]]s in this transaction.
   */
  getExportOutputs():Array<TransferableOutput> {
    return this.exportOuts;
  }

  /**
   * Returns the totall exported amount as a {@link https://github.com/indutny/bn.js/|BN}.
   */
  getExportTotal():BN {
    let val:BN = new BN(0);
    for(let i = 0; i < this.exportOuts.length; i++){
      val = val.add((this.exportOuts[i].getOutput() as AmountOutput).getAmount());
    }
    return val;
  }

  /**
   * Takes a {@link https://github.com/feross/buffer|Buffer} containing an [[ExportTx]], parses it, populates the class, and returns the length of the [[ExportTx]] in bytes.
   *
   * @param bytes A {@link https://github.com/feross/buffer|Buffer} containing a raw [[ExportTx]]
   *
   * @returns The length of the raw [[ExportTx]]
   *
   * @remarks assume not-checksummed
   */
  fromBuffer(bytes:Buffer, offset:number = 0):number {
    offset = super.fromBuffer(bytes, offset);
    this.destinationChain = bintools.copyFrom(bytes, offset, offset + 32);
    offset += 32;
    this.numOuts = bintools.copyFrom(bytes, offset, offset + 4);
    offset += 4;
    const numOuts:number = this.numOuts.readUInt32BE(0);
    for (let i:number = 0; i < numOuts; i++) {
      const anOut:TransferableOutput = new TransferableOutput();
      offset = anOut.fromBuffer(bytes, offset);
      this.exportOuts.push(anOut);
    }
    return offset;
  }

  /**
   * Returns a {@link https://github.com/feross/buffer|Buffer} representation of the [[ExportTx]].
   */
  toBuffer():Buffer {
    if(typeof this.destinationChain === "undefined") {
      throw new Error("ExportTx.toBuffer -- this.destinationChain is undefined");
    }
    this.numOuts.writeUInt32BE(this.exportOuts.length, 0);
    let barr:Array<Buffer> = [super.toBuffer(), this.destinationChain, this.numOuts];
    this.exportOuts = this.exportOuts.sort(TransferableOutput.comparator());
    for(let i = 0; i < this.exportOuts.length; i++) {
        barr.push(this.exportOuts[i].toBuffer());
    }
    return Buffer.concat(barr);
  }

  /**
   * Class representing an unsigned Export transaction.
   *
   * @param networkid Optional networkid, [[DefaultNetworkID]]
   * @param blockchainid Optional blockchainid, default Buffer.alloc(32, 16)
   * @param destinationChain Optional chainid which identifies where the funds will send to.
   * @param outs Optional array of the [[TransferableOutput]]s
   * @param ins Optional array of the [[TransferableInput]]s
   * @param exportOuts Array of [[TransferableOutputs]]s used in the transaction
   */
  constructor(
    networkid:number = DefaultNetworkID, blockchainid:Buffer = Buffer.alloc(32, 16), destinationChain:Buffer = undefined,
    outs:Array<TransferableOutput> = undefined, ins:Array<TransferableInput> = undefined,
    memo:Buffer = undefined, exportOuts:Array<TransferableOutput> = undefined
  ) {
    super(networkid, blockchainid, outs, ins, memo);
    this.destinationChain = destinationChain; //do not correct, it should bomb on toBuffer if not provided
    if (typeof exportOuts !== 'undefined' && Array.isArray(exportOuts)) {
      for (let i = 0; i < exportOuts.length; i++) {
        if (!(exportOuts[i] instanceof TransferableOutput)) {
          throw new Error("Error - ExportTx.constructor: invalid TransferableOutput in array parameter 'exportOuts'");
        }
      }
      this.exportOuts = exportOuts;
    }
  }
}