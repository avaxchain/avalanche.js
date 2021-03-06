/**
 * @packageDocumentation
 * @module API-AVM-Transactions
 */
import { Buffer } from 'buffer/';
import BinTools from '../../utils/bintools';
import {  AVMConstants } from './constants';
import { SelectCredentialClass } from './credentials';
import { AVMKeyChain, AVMKeyPair } from './keychain';
import { Credential } from '../../common/credentials';
import { StandardTx, StandardUnsignedTx } from '../../common/tx';
import createHash from 'create-hash';
import { BaseTx } from './basetx';
import { CreateAssetTx } from './createassettx';
import { OperationTx } from './operationtx';
import { ImportTx } from './importtx';
import { ExportTx } from './exporttx';

/**
 * @ignore
 */
const bintools = BinTools.getInstance();

export class UnsignedTx extends StandardUnsignedTx<AVMKeyPair, AVMKeyChain, BaseTx> {

  fromBuffer(bytes:Buffer, offset:number = 0):number {
    this.codecid = bintools.copyFrom(bytes, offset, offset + 2).readUInt16BE(0);
    offset += 2;
    const txtype:number = bintools.copyFrom(bytes, offset, offset + 4).readUInt32BE(0);
    offset += 4;
    this.transaction = SelectTxClass(txtype);
    return this.transaction.fromBuffer(bytes, offset);
  }
  
  /**
   * Signs this [[UnsignedTx]] and returns signed [[StandardTx]]
   *
   * @param kc An [[KeyChain]] used in signing
   *
   * @returns A signed [[StandardTx]]
   */
  sign(kc:AVMKeyChain):StandardTx<AVMKeyPair, AVMKeyChain, UnsignedTx> {
    const txbuff = this.toBuffer();
    const msg:Buffer = Buffer.from(createHash('sha256').update(txbuff).digest());
    const sigs:Array<Credential> = this.transaction.sign(msg, kc);
    return new Tx(this, sigs);
  }
}

export class Tx extends StandardTx<AVMKeyPair, AVMKeyChain, UnsignedTx> {
  /**
   * Takes a {@link https://github.com/feross/buffer|Buffer} containing an [[Tx]], parses it, populates the class, and returns the length of the Tx in bytes.
   *
   * @param bytes A {@link https://github.com/feross/buffer|Buffer} containing a raw [[Tx]]
   * @param offset A number representing the starting point of the bytes to begin parsing
   *
   * @returns The length of the raw [[Tx]]
   */
  fromBuffer(bytes:Buffer, offset:number = 0):number {
    this.unsignedTx = new UnsignedTx();
    offset = this.unsignedTx.fromBuffer(bytes, offset);
    const numcreds:number = bintools.copyFrom(bytes, offset, offset + 4).readUInt32BE(0);
    offset += 4;
    this.credentials = [];
    for (let i = 0; i < numcreds; i++) {
      const credid:number = bintools.copyFrom(bytes, offset, offset + 4).readUInt32BE(0);
      offset += 4;
      const cred:Credential = SelectCredentialClass(credid);
      offset = cred.fromBuffer(bytes, offset);
      this.credentials.push(cred);
    }
    return offset;
  }
}

/**
 * Takes a buffer representing the output and returns the proper [[BaseTx]] instance.
 *
 * @param txtype The id of the transaction type
 *
 * @returns An instance of an [[BaseTx]]-extended class.
 */
export const SelectTxClass = (txtype:number, ...args:Array<any>):BaseTx => {
  if (txtype === AVMConstants.BASETX) {
    const tx:BaseTx = new BaseTx(...args);
    return tx;
  } else if (txtype === AVMConstants.CREATEASSETTX) {
    const tx:CreateAssetTx = new CreateAssetTx(...args);
    return tx;
  } else if (txtype === AVMConstants.OPERATIONTX) {
    const tx:OperationTx = new OperationTx(...args);
    return tx;
  } else if (txtype === AVMConstants.IMPORTTX) {
    const tx:ImportTx = new ImportTx(...args);
    return tx;
  } else if (txtype === AVMConstants.EXPORTTX) {
    const tx:ExportTx = new ExportTx(...args);
    return tx;
  }
  /* istanbul ignore next */
  throw new Error(`Error - SelectTxClass: unknown txtype ${txtype}`);
};
