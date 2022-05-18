import fs from 'fs';
import path from 'path';
import { Cell, CellDep, Script, utils } from '@ckb-lumos/base';
import { SerializeWitnessArgs } from '@ckb-lumos/base/lib/core';
import { common } from '@ckb-lumos/common-scripts';
import { SECP_SIGNATURE_PLACEHOLDER } from '@ckb-lumos/common-scripts/lib/helper';
import { getConfig } from '@ckb-lumos/config-manager';
import { parseAddress, TransactionSkeleton } from '@ckb-lumos/helpers';
import { nonNullable } from '@force-bridge/x';
import { CkbDeployManager, OwnerCellConfig, OmniLockCellConfig } from '@force-bridge/x/dist/ckb/tx-helper/deploy';
import { txSkeletonToRawTransactionToSign } from '@force-bridge/x/dist/ckb/tx-helper/generator';
import { CkbIndexer, ScriptType } from '@force-bridge/x/dist/ckb/tx-helper/indexer';
import { initLumosConfig } from '@force-bridge/x/dist/ckb/tx-helper/init_lumos_config';
import { calculateFee, getTransactionSize } from '@force-bridge/x/dist/ckb/tx-helper/utils';
import {
  CKB_TYPESCRIPT_HASH,
  CkbDeps,
  ConfigItem,
  WhiteListEthAsset,
  WhiteListNervosAsset,
} from '@force-bridge/x/dist/config';
import { asyncSleep, privateKeyToCkbAddress, writeJsonToFile } from '@force-bridge/x/dist/utils';
import { logger } from '@force-bridge/x/dist/utils/logger';
import {
  deployEthContract,
  deployAssetManager,
  deploySafe,
  deployEthMirror,
  unsignedAddEthMirrorTxToFile,
  signAddEthMirrorTxToFile,
  sendEthMirrorTxFromFiles,
} from '@force-bridge/x/dist/xchain/eth';
import { ContractNetworksConfig } from '@gnosis.pm/safe-core-sdk';
import CKB from '@nervosnetwork/ckb-sdk-core';
import { normalizers, Reader } from 'ckb-js-toolkit';
import { Contract, ethers } from 'ethers';
import * as lodash from 'lodash';
import { genRandomVerifierConfig, VerifierConfig } from './generate';
import { execShellCmd, pathFromProjectRoot } from './index';

export interface DeployDevResult {
  assetWhiteList: WhiteListEthAsset[];
  nervosAssetWhiteList: WhiteListNervosAsset[];
  ckbDeps: CkbDeps;
  ownerConfig: OwnerCellConfig;
  omniLockConfig: OmniLockCellConfig;
  bridgeEthAddress: string;
  multisigConfig: {
    threshold: number;
    verifiers: VerifierConfig[];
  };
  ckbStartHeight: number;
  ethStartHeight: number;
  ckbPrivateKey: string;
  ethPrivateKey: string;
  assetManagerContractAddress: string;
  safeAddress: string;
  safeContractNetworks?: ContractNetworksConfig;
}

export async function mintDevToken(
  CKB_RPC_URL: string,
  CKB_INDEXER_URL: string,
  sudtType: ConfigItem,
  ownerPrivateKey: string,
  recipientAddress: string,
  amount: bigint,
): Promise<string> {
  const ckb = new CKB(CKB_RPC_URL);
  const lumosConfig = getConfig();
  const ckbIndexer = new CkbIndexer(CKB_RPC_URL, CKB_INDEXER_URL);
  await ckbIndexer.waitForSync();
  const sudtDep: CellDep = {
    out_point: {
      tx_hash: sudtType.cellDep.outPoint.txHash,
      index: sudtType.cellDep.outPoint.index,
    },
    dep_type: sudtType.cellDep.depType,
  };
  let txSkeleton = TransactionSkeleton({ cellProvider: ckbIndexer });
  txSkeleton = txSkeleton.update('cellDeps', (cellDeps) => {
    const found = nonNullable(lumosConfig.SCRIPTS.SECP256K1_BLAKE160);
    return cellDeps
      .push({
        dep_type: found.DEP_TYPE,
        out_point: { tx_hash: found.TX_HASH, index: found.INDEX },
      })
      .push(sudtDep);
  });

  const ownerAddress = privateKeyToCkbAddress(ownerPrivateKey);
  logger.info(`owner address: ${ownerAddress}`);

  const ownerLockscript = parseAddress(ownerAddress);
  logger.info(`owner lockScript: ${ownerLockscript}`);

  const args = utils.computeScriptHash(ownerLockscript);
  const sudtTypescript: Script = {
    code_hash: sudtType.script.codeHash,
    args,
    hash_type: sudtType.script.hashType,
  };

  const ckbCells = await ckbIndexer.getCells(
    {
      script: ownerLockscript,
      script_type: ScriptType.lock,
    },
    undefined,
  );
  const ckbLockCells = ckbCells.filter((cell) => !cell.cell_output.type);
  const inputCell = ckbLockCells[ckbLockCells.length - 1];
  const inputCapacity = BigInt(inputCell.cell_output.capacity);
  const sudtCapacity = BigInt(200 * 10 ** 8);

  const recipientScript = parseAddress(recipientAddress);
  const recipientCell: Cell = {
    cell_output: {
      capacity: `0x${sudtCapacity.toString(16)}`,
      lock: recipientScript,
      type: sudtTypescript,
    },
    data: utils.toBigUInt128LE(amount),
  };
  txSkeleton = txSkeleton.update('inputs', (outputs) => {
    return outputs.push(inputCell);
  });
  txSkeleton = txSkeleton.update('outputs', (outputs) => {
    return outputs.push(recipientCell);
  });
  txSkeleton = txSkeleton.update('outputs', (outputs) => {
    return outputs.push(inputCell);
  });

  const witness = new Reader(
    SerializeWitnessArgs(
      normalizers.NormalizeWitnessArgs({
        lock: SECP_SIGNATURE_PLACEHOLDER,
      }),
    ),
  ).serializeJson();
  txSkeleton = txSkeleton.update('witnesses', (w) => {
    return w.push(witness);
  });
  const txFee = calculateFee(getTransactionSize(txSkeleton));
  txSkeleton = txSkeleton.update('outputs', (outputs) => {
    outputs.get(1)!.cell_output.capacity = `0x${BigInt(inputCapacity - sudtCapacity - txFee).toString(16)}`;
    return outputs;
  });
  txSkeleton = common.prepareSigningEntries(txSkeleton);
  const rawTx = txSkeletonToRawTransactionToSign(txSkeleton);
  const signedTx = ckb.signTransaction(ownerPrivateKey)(rawTx);
  try {
    const realTxHash = await ckb.rpc.sendTransaction(signedTx, 'passthrough');
    logger.info(`realTxHash: ${JSON.stringify(realTxHash, null, 2)}`);
    for (let i = 0; i < 600; i++) {
      const tx = await ckb.rpc.getTransaction(realTxHash);
      logger.info('mint dev_token tx', tx);
      if (tx.txStatus.status === 'committed') {
        break;
      }
      await asyncSleep(6000);
    }
    logger.info('mint dev_token tx success ', realTxHash);
    return args;
  } catch (e) {
    logger.error(e.stack);
    return '';
  }
}

export async function deployDev(
  ETH_RPC_URL: string,
  CKB_RPC_URL: string,
  CKB_INDEXER_URL: string,
  MULTISIG_NUMBER: number,
  MULTISIG_THRESHOLD: number,
  ethPrivateKey: string,
  ckbPrivateKey: string,
  env: 'LINA' | 'AGGRON4' | 'DEV' = 'DEV',
  multiCellXchainType: string,
  configPath: string,
  ckbDeps?: CkbDeps,
): Promise<DeployDevResult> {
  const cachePath = path.join(configPath, 'deployConfig.json');
  if (cachePath && fs.existsSync(cachePath)) {
    return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  }
  initLumosConfig(env);
  const verifierConfigs = lodash.range(MULTISIG_NUMBER).map((_i) => genRandomVerifierConfig());
  logger.debug('verifierConfigs', verifierConfigs);
  const ethMultiSignAddresses = verifierConfigs.map((vc) => vc.ethAddress);
  // deploy eth contract
  const bridgeEthAddress = await deployEthContract(
    ETH_RPC_URL,
    ethPrivateKey,
    ethMultiSignAddresses,
    MULTISIG_THRESHOLD,
  );
  logger.info(`bridge address: ${bridgeEthAddress}`);

  const ckbDeployGenerator = new CkbDeployManager(CKB_RPC_URL, CKB_INDEXER_URL);
  if (!ckbDeps) {
    // deploy ckb contracts
    let sudtDep;
    let pwLockDep;
    let omniLockDep;
    let PATH_BRIDGE_LOCKSCRIPT;
    let PATH_RECIPIENT_TYPESCRIPT;
    if (env === 'DEV') {
      PATH_RECIPIENT_TYPESCRIPT = pathFromProjectRoot('/ckb-contracts/build/release-devnet/recipient-typescript');
      PATH_BRIDGE_LOCKSCRIPT = pathFromProjectRoot('/ckb-contracts/build/release-devnet/bridge-lockscript');
      const PATH_SUDT_DEP = pathFromProjectRoot('/offchain-modules/deps/simple_udt');
      const PATH_PW_LOCK_DEP = pathFromProjectRoot('/offchain-modules/deps/pw_lock');
      const PATH_OMNI_LOCK_DEP = pathFromProjectRoot('/offchain-modules/deps/omni_lock');
      const sudtBin = fs.readFileSync(PATH_SUDT_DEP);
      const pwLockBin = fs.readFileSync(PATH_PW_LOCK_DEP);
      const omniLockBin = fs.readFileSync(PATH_OMNI_LOCK_DEP);
      [sudtDep, pwLockDep, omniLockDep] = await ckbDeployGenerator.deployScripts(
        [sudtBin, pwLockBin, omniLockBin],
        ckbPrivateKey,
      );
      logger.info('deployed pwLockDep', JSON.stringify(pwLockDep, null, 2));
    } else if (env === 'AGGRON4') {
      PATH_RECIPIENT_TYPESCRIPT = pathFromProjectRoot('/ckb-contracts/build/release-aggron/recipient-typescript');
      PATH_BRIDGE_LOCKSCRIPT = pathFromProjectRoot('/ckb-contracts/build/release-aggron/bridge-lockscript');
      sudtDep = {
        cellDep: {
          depType: 'code',
          outPoint: {
            txHash: '0xe12877ebd2c3c364dc46c5c992bcfaf4fee33fa13eebdf82c591fc9825aab769',
            index: '0x0',
          },
        },
        script: {
          codeHash: '0xc5e5dcf215925f7ef4dfaf5f4b4f105bc321c02776d6e7d52a1db3fcd9d011a4',
          hashType: 'type',
        },
      };
      pwLockDep = {
        cellDep: {
          depType: 'code',
          outPoint: {
            txHash: '0x57a62003daeab9d54aa29b944fc3b451213a5ebdf2e232216a3cfed0dde61b38',
            index: '0x0',
          },
        },
        script: {
          codeHash: '0x58c5f491aba6d61678b7cf7edf4910b1f5e00ec0cde2f42e0abb4fd9aff25a63',
          hashType: 'type',
        },
      };
    } else {
      throw new Error(`wrong env: ${env}`);
    }
    const contractsDeps = await ckbDeployGenerator.deployContracts(
      {
        bridgeLockscript: fs.readFileSync(PATH_BRIDGE_LOCKSCRIPT),
        recipientTypescript: fs.readFileSync(PATH_RECIPIENT_TYPESCRIPT),
      },
      ckbPrivateKey,
    );
    logger.info('deps', { contractsDeps, sudtDep });
    ckbDeps = {
      sudtType: sudtDep,
      pwLock: pwLockDep,
      omniLock: omniLockDep,
      ...contractsDeps,
    };
  }
  const multisigItem = {
    R: 0,
    M: MULTISIG_THRESHOLD,
    publicKeyHashes: verifierConfigs.map((vc) => vc.ckbPubkeyHash),
  };
  const offchainModulePath = pathFromProjectRoot('offchain-modules');
  const tsnodePath = path.join(offchainModulePath, 'node_modules/.bin/ts-node');
  const ckbUpgradeDeployCli = `${tsnodePath} ${offchainModulePath}/packages/scripts/src/ckb-upgrade-deploy.ts`;
  await execShellCmd(
    `${ckbUpgradeDeployCli} owner-cell --ckbRpcUrl ${CKB_RPC_URL} --ckbIndexerUrl ${CKB_INDEXER_URL} --env DEV --ckbPrivateKey ${ckbPrivateKey} -R ${
      multisigItem.R
    } -M ${multisigItem.M} --publicKeyHashes ${multisigItem.publicKeyHashes.join(',')} -x ${multiCellXchainType}`,
    true,
  );
  const ownerCellResult = fs.readFileSync(`${offchainModulePath}/owner-cell-result.json`).toString();
  const ownerConfig: OwnerCellConfig = JSON.parse(ownerCellResult);
  logger.info('ownerConfig', ownerConfig);
  await execShellCmd(
    `${ckbUpgradeDeployCli} admin-cell --ckbRpcUrl ${CKB_RPC_URL} --ckbIndexerUrl ${CKB_INDEXER_URL} --env DEV --ckbPrivateKey ${ckbPrivateKey} -R ${
      multisigItem.R
    } -M ${multisigItem.M} --publicKeyHashes ${multisigItem.publicKeyHashes.join(',')} --omniLockScriptCodeHash ${
      ckbDeps.omniLock!.script.codeHash
    } --omniLockScriptHashType ${ckbDeps.omniLock!.script.hashType}`,
    true,
  );
  const adminCellResult = fs.readFileSync(`${offchainModulePath}/admin-cell-result.json`).toString();
  const omniLockConfig: OmniLockCellConfig = JSON.parse(adminCellResult);
  logger.info('omniLockConfig', omniLockConfig);

  // generate_configs
  let assetWhiteList: WhiteListEthAsset[];
  let nervosAssetWhiteList: WhiteListNervosAsset[];
  if (env === 'DEV') {
    const assetWhiteListPath = pathFromProjectRoot('/configs/devnet-asset-white-list.json');
    const nervosAssetWhiteListPath = pathFromProjectRoot('/configs/devnet-nervos-asset-white-list.json');
    assetWhiteList = JSON.parse(fs.readFileSync(assetWhiteListPath, 'utf8'));
    nervosAssetWhiteList = JSON.parse(fs.readFileSync(nervosAssetWhiteListPath, 'utf8'));
    const devSudtArgs = await mintDevToken(
      CKB_RPC_URL,
      CKB_INDEXER_URL,
      ckbDeps.sudtType,
      ckbPrivateKey,
      privateKeyToCkbAddress(ckbPrivateKey),
      BigInt('10000000000000000'),
    );
    nervosAssetWhiteList.push({
      typescriptHash: '',
      sudtArgs: devSudtArgs,
      xchainTokenAddress: '',
      name: 'DEV_TOKEN',
      symbol: 'DEV_TOKEN',
      decimal: 8,
      logoURI: '',
      minimalBridgeAmount: '100000000',
    });
  } else if (env === 'AGGRON4') {
    const assetWhiteListPath = pathFromProjectRoot('/configs/testnet-asset-white-list.json');
    const nervosAssetWhiteListPath = pathFromProjectRoot('/configs/testnet-nervos-asset-white-list.json');
    assetWhiteList = JSON.parse(fs.readFileSync(assetWhiteListPath, 'utf8'));
    nervosAssetWhiteList = JSON.parse(fs.readFileSync(nervosAssetWhiteListPath, 'utf8'));
  } else {
    throw new Error(`wrong env: ${env}`);
  }
  const typescript = ckbDeps.sudtType.script;
  nervosAssetWhiteList
    .filter((asset) => asset.typescriptHash !== CKB_TYPESCRIPT_HASH && asset.sudtArgs)
    .map((asset) => {
      if (!asset.typescriptHash) {
        asset.typescriptHash = utils.computeScriptHash({
          code_hash: typescript.codeHash,
          hash_type: typescript.hashType,
          args: asset.sudtArgs!,
        });
      }
    });
  const multisigConfig = {
    threshold: MULTISIG_THRESHOLD,
    verifiers: verifierConfigs,
  };

  const { safeAddress, safeContractNetworks, assetManagerContract } = await deployEthCkb2Eth(
    ETH_RPC_URL,
    ethPrivateKey,
    MULTISIG_THRESHOLD,
    verifierConfigs,
    nervosAssetWhiteList,
    path.join(configPath, 'deployGnosis/'),
  );

  // get start height
  const provider = new ethers.providers.JsonRpcProvider(ETH_RPC_URL);
  const delta = 1;
  const ethStartHeight = (await provider.getBlockNumber()) - delta;
  const ckb = new CKB(CKB_RPC_URL);
  const ckbStartHeight = Number(await ckb.rpc.getTipBlockNumber()) - delta;
  logger.debug('start height', { ethStartHeight, ckbStartHeight });
  const data = {
    assetWhiteList,
    nervosAssetWhiteList,
    ckbDeps,
    ownerConfig,
    omniLockConfig,
    bridgeEthAddress,
    multisigConfig,
    ckbStartHeight,
    ethStartHeight,
    ethPrivateKey,
    ckbPrivateKey,
    assetManagerContractAddress: assetManagerContract.address,
    safeAddress,
    safeContractNetworks,
  };
  if (cachePath) {
    writeJsonToFile(data, cachePath);
  }
  return data;
}

async function deployEthCkb2Eth(
  url: string,
  privateKey: string,
  threshold: number,
  owners: VerifierConfig[],
  nervosAssetWhiteList: WhiteListNervosAsset[],
  basePath: string,
): Promise<{
  nervosAssetWhiteList: WhiteListNervosAsset[];
  safeAddress: string;
  assetManagerContract: Contract;
  safeContractNetworks?: ContractNetworksConfig;
}> {
  const { safeAddress, contractNetworks } = await deploySafe(
    url,
    privateKey,
    threshold,
    owners.map((o) => o.ethAddress),
  );
  const assetManagerContract = await deployAssetManager(url, privateKey, safeAddress);
  for (const v of nervosAssetWhiteList) {
    const ckbEthMirror = await deployEthMirror(
      url,
      privateKey,
      v.name,
      v.symbol,
      v.decimal,
      assetManagerContract.address,
    );
    logger.info(`ckb mirror address: ${ckbEthMirror.address} asset id:${v.typescriptHash}`);

    v.xchainTokenAddress = ckbEthMirror.address;

    const txPath = path.join(basePath, `${v.typescriptHash}-tx.json`);

    await unsignedAddEthMirrorTxToFile(
      url,
      safeAddress,
      assetManagerContract.address,
      ckbEthMirror.address,
      v.typescriptHash,
      privateKey,
      txPath,
      contractNetworks,
    );

    for (const owner of owners) {
      const sigPath = path.join(basePath, `${v.typescriptHash}-sig-${owner.ethAddress}.json`);
      fs.copyFileSync(txPath, sigPath);
      await signAddEthMirrorTxToFile(sigPath, owner.privkey);
    }

    fs.rmSync(txPath);

    await sendEthMirrorTxFromFiles(basePath, privateKey);

    for (const file of fs.readdirSync(basePath)) {
      fs.rmSync(path.join(basePath, file));
    }

    fs.rmdirSync(basePath);

    logger.info(`ckb mirror added to asset manager. address: ${ckbEthMirror.address} asset id:${v.typescriptHash}`);
  }

  return { nervosAssetWhiteList, safeContractNetworks: contractNetworks, safeAddress, assetManagerContract };
}
