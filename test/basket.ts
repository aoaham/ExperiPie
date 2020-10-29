import chai, {expect} from "chai";
import { deployContract, solidity} from "ethereum-waffle";
import { ethers, run, ethereum, network } from "@nomiclabs/buidler";
import { Signer, constants, BigNumber, utils, Contract, BytesLike } from "ethers";

import BasketFacetArtifact from "../artifacts/BasketFacet.json";
import Erc20FacetArtifact from "../artifacts/ERC20Facet.json";
import TestTokenArtifact from "../artifacts/TestToken.json";
import { Erc20Facet, BasketFacet, DiamondFactoryContract, TestToken } from "../typechain";
import {IExperiPieFactory} from "../typechain/IExperiPieFactory";
import {IExperiPie} from "../typechain/IExperiPie";
import TimeTraveler from "../utils/TimeTraveler";
import { parseEther } from "ethers/lib/utils";

chai.use(solidity);

const FacetCutAction = {
    Add: 0,
    Replace: 1,
    Remove: 2,
};


function getSelectors(contract: Contract) {
    const signatures: BytesLike[] = [];
    for(const key of Object.keys(contract.functions)) {
        signatures.push(utils.keccak256(utils.toUtf8Bytes(key)).substr(0, 10));
    }

    return signatures;
}

describe.only("BasketFacet", function() {
    this.timeout(300000);

    let experiPie: IExperiPie;
    let account: string;
    let signers: Signer[];
    let timeTraveler: TimeTraveler;
    const testTokens: TestToken[] = [];

    before(async() => {
        signers = await ethers.getSigners();
        account = await signers[0].getAddress();
        timeTraveler = new TimeTraveler(ethereum);

        const diamondFactory = (await run("deploy-diamond-factory")) as DiamondFactoryContract;
        
        const basketFacet = (await deployContract(signers[0], BasketFacetArtifact)) as BasketFacet;
        const erc20Facet = (await deployContract(signers[0], Erc20FacetArtifact)) as Erc20Facet;

        await diamondFactory.deployNewDiamond(
            account,
            [
                {
                    action: FacetCutAction.Add,
                    facetAddress: basketFacet.address,
                    functionSelectors: getSelectors(basketFacet)
                },
                {
                    action: FacetCutAction.Add,
                    facetAddress: erc20Facet.address,
                    functionSelectors: getSelectors(erc20Facet)
                }
            ]
        )


        const experiPieAddress = await diamondFactory.diamonds(0);
        experiPie = IExperiPieFactory.connect(experiPieAddress, signers[0]);

        for(let i = 0; i < 3; i ++) {
          const token = await (deployContract(signers[0], TestTokenArtifact, ["Mock", "Mock"])) as TestToken;
          await token.mint(parseEther("1000000"), account);
          testTokens.push(token);
        }

        await timeTraveler.snapshot();
    });

    beforeEach(async() => {
        await timeTraveler.revertSnapshot();
    });


    describe("MaxCap", async () => {
        it("Check default cap", async () => {
          const maxCap = await experiPie.getCap();
          expect(maxCap).to.be.eq("0");
        });
        it("Test setCap not allowed", async () => {
          let experiPieAltSigner = experiPie.connect(signers[1]);
          await expect(
            experiPieAltSigner
              .setCap(parseEther("1000"))
          ).to.be.revertedWith("NOT_ALLOWED");
          
        });
        it("Set max cap", async () => {
          await experiPie.setCap(parseEther("100"));
          const maxCap = await experiPie.getCap();
          expect(maxCap).to.eq(parseEther("100"));
        });
    });

    describe("Lock", async () => {
        it("Check default locked", async () => {
            const lock = await experiPie.getLock();
            expect(lock).to.be.true;
        });
        it("Test setlock not allowed", async () => {
            const experiPieAltSigner = experiPie.connect(signers[1]);
            await expect(
                experiPieAltSigner.setLock(1)
            ).to.be.revertedWith("NOT_ALLOWED");
        });
        it("Check past lock", async () => {
          // set blockNumber to at least 2
          await timeTraveler.mine_blocks(2);
    
          // set lock in the past
          await experiPie.setLock(1);
          const lock = await experiPie.getLock();
          expect(lock).to.be.false;
        });
        it("Check future lock", async () => {
          const latestBlock = await ethers.provider.getBlockNumber();
          // set lock in the future
          await experiPie.setLock(latestBlock + 10);
          const lock = await experiPie.getLock();
          expect(lock).to.be.true;
        });
        it("Check current block lock", async () => {
          // assert lock == currentblock
          const latestBlock = await ethers.provider.getBlockNumber();
          await experiPie.setLock(latestBlock + 1);
          const lockBlock = await experiPie.getLockBlock();
          expect(lockBlock).to.eq(latestBlock + 1);
    
          // should still be locked (block is including)
          const lock = await experiPie.getLock();
          expect(lock).to.be.true;
        });
        it("Wait for lock expires", async () => {
          const latestBlock = await ethers.provider.getBlockNumber();

          await experiPie.setLock(latestBlock + 10);
          await timeTraveler.mine_blocks(11);

          const lock = await experiPie.getLock();
          expect(lock).to.be.false;
        });
      });

      describe("Joining and exiting", async () => {
        beforeEach(async() => {
          for(let token of testTokens) {
            await token.approve(experiPie.address, constants.MaxUint256);
            await token.transfer(experiPie.address, parseEther("10000"));
            const account1 = await signers[1].getAddress();
            await token.mint(parseEther("10000"), account1);
            token.connect(signers[1]).approve(experiPie.address, constants.MaxUint256);
            await experiPie.addToken(token.address);
          }

          await experiPie.initialize(parseEther("100"), "TEST", "TEST", 18);
          await experiPie.setLock(constants.One);
          await experiPie.setCap(constants.MaxUint256);
        });

        const getBalances = async(address: string) => {
          return {
            t0: await testTokens[0].balanceOf(address),
            t1: await testTokens[1].balanceOf(address),
            t2: await testTokens[2].balanceOf(address),
            pie: await experiPie.balanceOf(address)
          }
        }

        it("Test locks", async () => {
          const latestBlock = await ethers.provider.getBlockNumber();
          await experiPie.setLock(latestBlock + 5);
          await expect(
            experiPie.joinPool(parseEther("1"))
          ).to.be.revertedWith("POOL_LOCKED");
    
          await expect(
            experiPie.exitPool(parseEther("1"))
          ).to.be.revertedWith("POOL_LOCKED");
        });
        it("Join pool", async () => {
          const mintAmount = parseEther("1");

          const totalSupplyBefore = await experiPie.totalSupply();
          const userBalancesBefore = await getBalances(account);
          const pieBalancesBefore = await getBalances(experiPie.address);
          
          await experiPie.joinPool(mintAmount);
          
          const totalSupplyAfter = await experiPie.totalSupply();
          const userBalancesAfter = await getBalances(account);
          const pieBalancesAfter = await getBalances(experiPie.address);

          const expectedTokenAmount = pieBalancesBefore.t0.mul(mintAmount).div(totalSupplyBefore);
          
          expect(totalSupplyAfter).to.eq(totalSupplyBefore.add(mintAmount));

          // Verify user balances
          expect(userBalancesAfter.t0).to.eq(userBalancesBefore.t0.sub(expectedTokenAmount));
          expect(userBalancesAfter.t1).to.eq(userBalancesBefore.t1.sub(expectedTokenAmount));
          expect(userBalancesAfter.t2).to.eq(userBalancesBefore.t2.sub(expectedTokenAmount));
          expect(userBalancesAfter.pie).to.eq(userBalancesBefore.pie.add(mintAmount));
          
          // Verify pie balances
          expect(pieBalancesAfter.t0).to.eq(pieBalancesBefore.t0.add(expectedTokenAmount));
          expect(pieBalancesAfter.t1).to.eq(pieBalancesBefore.t1.add(expectedTokenAmount));
          expect(pieBalancesAfter.t2).to.eq(pieBalancesBefore.t2.add(expectedTokenAmount));

        });
        it("Exit pool", async () => {
          const burnAmount = parseEther("5");
          

          const totalSupplyBefore = await experiPie.totalSupply();
          const userBalancesBefore = await getBalances(account);
          const pieBalancesBefore = await getBalances(experiPie.address);
          
          await experiPie.exitPool(burnAmount);

          const totalSupplyAfter = await experiPie.totalSupply();
          const userBalancesAfter = await getBalances(account);
          const pieBalancesAfter = await getBalances(experiPie.address);

          const expectedTokenAmount = pieBalancesBefore.t0.mul(burnAmount).div(totalSupplyBefore);
          
          expect(totalSupplyAfter).to.eq(totalSupplyBefore.sub(burnAmount));

          // Verify user balances
          expect(userBalancesAfter.t0).to.eq(userBalancesBefore.t0.add(expectedTokenAmount));
          expect(userBalancesAfter.t1).to.eq(userBalancesBefore.t1.add(expectedTokenAmount));
          expect(userBalancesAfter.t2).to.eq(userBalancesBefore.t2.add(expectedTokenAmount));
          expect(userBalancesAfter.pie).to.eq(userBalancesBefore.pie.sub(burnAmount));

          // Verify Pie balances
          expect(pieBalancesAfter.t0).to.eq(pieBalancesBefore.t0.sub(expectedTokenAmount));
          expect(pieBalancesAfter.t1).to.eq(pieBalancesBefore.t1.sub(expectedTokenAmount));
          expect(pieBalancesAfter.t2).to.eq(pieBalancesBefore.t2.sub(expectedTokenAmount));
          
        });
        it("Join fails if it exceeds balance", async () => {
          await expect(
            experiPie.joinPool(parseEther("10000"))
          ).to.be.revertedWith("transfer amount exceeds balance");
        });
        it("Exit fails if it exceeds MIN_AMOUNT", async () => {
          const balance = await experiPie.balanceOf(account);
          await expect(
            experiPie.exitPool(balance.sub(1))
          ).to.be.revertedWith("TOKEN_BALANCE_TOO_LOW");
        });
        it("Join pool with two accounts", async () => {
          const mintAmount = parseEther("100");
          const experiPieAltSigner =  experiPie.connect(signers[1]);

          const account1 = await signers[1].getAddress();
          
          const totalSupplyBefore = await experiPie.totalSupply();
          const user0BalancesBefore = await getBalances(account);
          const user1BalancesBefore = await getBalances(account1);
          const pieBalancesBefore = await getBalances(experiPie.address);

          await experiPie.joinPool(mintAmount);
          await experiPieAltSigner.joinPool(mintAmount);

          const totalSupplyAfter = await experiPie.totalSupply();
          const user0BalancesAfter = await getBalances(account);
          const user1BalancesAfter = await getBalances(account1);
          const pieBalancesAfter = await getBalances(experiPie.address);

          const expectedTokenAmount = pieBalancesBefore.t0.mul(mintAmount).div(totalSupplyBefore);

          expect(totalSupplyAfter).to.eq(totalSupplyBefore.add(mintAmount.mul(2)));

          // Verify user0 balances
          expect(user0BalancesAfter.t0).to.eq(user0BalancesBefore.t0.sub(expectedTokenAmount));
          expect(user0BalancesAfter.t1).to.eq(user0BalancesBefore.t1.sub(expectedTokenAmount));
          expect(user0BalancesAfter.t2).to.eq(user0BalancesBefore.t2.sub(expectedTokenAmount));
          expect(user0BalancesAfter.pie).to.eq(user0BalancesBefore.pie.add(mintAmount));

          // Verify user1 balances
          expect(user1BalancesAfter.t0).to.eq(user1BalancesBefore.t0.sub(expectedTokenAmount));
          expect(user1BalancesAfter.t1).to.eq(user1BalancesBefore.t1.sub(expectedTokenAmount));
          expect(user1BalancesAfter.t2).to.eq(user1BalancesBefore.t2.sub(expectedTokenAmount));
          expect(user1BalancesAfter.pie).to.eq(user1BalancesBefore.pie.add(mintAmount));

          // Verify pie balances
          expect(pieBalancesAfter.t0).to.eq(pieBalancesBefore.t0.add(expectedTokenAmount.mul(2)));
          expect(pieBalancesAfter.t1).to.eq(pieBalancesBefore.t1.add(expectedTokenAmount.mul(2)));
          expect(pieBalancesAfter.t2).to.eq(pieBalancesBefore.t2.add(expectedTokenAmount.mul(2)));

        });
        it("Exit fails if it exceeds balance of user", async () => {
          const balance = await experiPie.balanceOf(account);
          await expect(
            experiPie.exitPool(balance.add(1))
          ).to.be.revertedWith("subtraction overflow");
        });
        it("Join fails if it exceeds max cap", async () => {
          const totalSupply = await experiPie.totalSupply();
          const mintAmount = parseEther("10000");

          await experiPie.setCap(totalSupply.add(mintAmount).sub(1))
    
          await expect(
            experiPie.joinPool(mintAmount)
          ).to.be.revertedWith("MAX_POOL_CAP_REACHED");
        });
        it("Adding a token", async() => {
          const addedToken = await (deployContract(signers[0], TestTokenArtifact, ["Mock", "Mock"])) as TestToken;
          
          const tokensBefore = await experiPie.getTokens();

          await addedToken.mint(parseEther("1000000"), account);
          await addedToken.transfer(experiPie.address, parseEther("1000"));
          await experiPie.addToken(addedToken.address);

          const tokensAfter = await experiPie.getTokens();
          const tokenInPool = await experiPie.getTokenInPool(addedToken.address);

          expect(tokensAfter.length).to.eq(tokensBefore.length + 1);
          expect(tokensAfter[tokensAfter.length - 1]).to.eq(addedToken.address);
          expect(tokenInPool).to.be.true;
        });
        it("Adding token not allowed", async() => {
          await expect(experiPie.connect(signers[1]).addToken(constants.AddressZero)).to.be.revertedWith("NOT_ALLOWED");
        });
        it("Adding a token with less than MIN_AMOUNT should fail", async() => {
          const addedToken = await (deployContract(signers[0], TestTokenArtifact, ["Mock", "Mock"])) as TestToken;
          await expect(experiPie.addToken(addedToken.address)).to.be.revertedWith("BALANCE_TOO_SMALL"); 
        });
        it("Adding a token which is already in the pool should fail", async() => {
          await expect(experiPie.addToken(testTokens[0].address)).to.be.revertedWith("TOKEN_ALREADY_IN_POOL");
        });
        it("Removing a token", async() => {
          const tokensBefore = await experiPie.getTokens();
          await experiPie.removeToken(testTokens[1].address);
          const tokensAfter = await experiPie.getTokens();

          const inPool = await experiPie.getTokenInPool(testTokens[1].address);

          expect(tokensAfter.length).to.eq(tokensBefore.length - 1);
          expect(inPool).to.be.false;
          expect(tokensAfter[0]).to.eq(tokensBefore[0]);
          expect(tokensAfter[1]).to.eq(tokensBefore[2]);
        });
        it("Removing a token not allowed", async() => {
          await expect(experiPie.connect(signers[1]).removeToken(testTokens[1].address)).to.be.revertedWith("NOT_ALLOWED");
        });
        it("Removing a token not in the pool should fail", async() => {
          await expect(experiPie.removeToken(constants.AddressZero)).to.be.revertedWith("TOKEN_NOT_IN_POOL");
        });
      });

})