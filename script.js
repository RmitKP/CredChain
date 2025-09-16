/* ===== CONFIG ===== */
const STAKING_CONTRACT_ADDRESS = "0x968EB460e2c356F849631f2aa206bB0Ebf87173c";
const STAKING_ABI = [
  {"inputs":[{"internalType":"uint256","name":"daysLock","type":"uint256"}],"name":"stake","outputs":[],"stateMutability":"payable","type":"function"},
  {"inputs":[],"name":"withdraw","outputs":[],"stateMutability":"nonpayable","type":"function"},
  {"inputs":[{"internalType":"address","name":"user","type":"address"}],"name":"getStake","outputs":[{"internalType":"uint256","name":"amount","type":"uint256"},{"internalType":"uint256","name":"unlockTime","type":"uint256"}],"stateMutability":"view","type":"function"}
];
const ETHERSCAN_API_KEY = 'Z887TI5HFVAREZKQIVFU1NF2GFE2FFH1KZ';
const ETHERSCAN_BASE = 'https://api-sepolia.etherscan.io/api';
const SEPOLIA_CHAIN_ID = '0xaa36a7';
/* ================== */

let web3, contract, account;
let lastReport = "", currentScore = 0;

const $ = id => document.getElementById(id);   // Shortcut for DOM access

// Display small status messages with icons (info/success/error)
function setSmallStatus(el, msg, type='info'){
  const icons = {info:'⏳', success:'✅', error:'❌'};
  el.innerText = `${icons[type]||''} ${msg}`;
}
function openModal(id){ $(id).style.display = 'block'; }   // Open a modal window by ID
function closeModal(id){ $(id).style.display = 'none'; }   // Close a modal window by ID

// Global listener for modal close buttons.
// Ensures any `[data-close]` element or `.close` button will close its parent modal.
document.addEventListener('click', (e) => {
  if(e.target.matches('[data-close]') || e.target.classList.contains('close')) {
    const id = e.target.getAttribute('data-close') || e.target.parentElement?.getAttribute('data-close');
    if(id) closeModal(id);
  }
});

// Initialize the dApp:
// - Ensures MetaMask is present
// - Creates Web3 and Contract instances
// - Wires up all buttons and input events
// - Attempts auto-connection if user already authorized
async function init(){
  if(typeof window.ethereum === 'undefined'){
    alert('MetaMask is required.'); return;
  }
  web3 = new Web3(window.ethereum);
  contract = new web3.eth.Contract(STAKING_ABI, STAKING_CONTRACT_ADDRESS);
  $('contractAddr') && ($('contractAddr').innerText = STAKING_CONTRACT_ADDRESS);

  // Main button handlers
  $('connectBtn').onclick = connectWallet;
  $('btnStake').onclick = () => openModal('stakeModal');
  $('btnBorrow').onclick = () => openModal('borrowModal');
  $('btnHash').onclick = () => { $('fullReport').value = lastReport; openModal('hashModal'); };

  // Stake modal actions
  $('stakeConfirm').onclick = doStake;
  $('stakeWithdraw').onclick = doWithdraw;
  $('stakeAmount').oninput = previewStake;
  $('stakeDays').oninput = previewStake;

  // Borrow modal
  $('borrowSignBtn').onclick = doGenerateLoan;
  ['borrowAmount','borrowYears','paymentsPerYear','borrowDeposit'].forEach(id => {
    $(id).addEventListener('input', updateLoanHint);
    $(id).addEventListener('change', updateLoanHint);
  });

  // Publish modal
  $('publishBtn').onclick = doPublish;

  // Try auto-connect if already authorized in MetaMask
  try{
    const accounts = await web3.eth.getAccounts();
    if(accounts && accounts.length>0){ account = accounts[0]; afterConnect(); }
  }catch(e){}
}

// Request MetaMask connection and ensure Sepolia network.
// Automatically adds Sepolia if not already present in wallet.
async function connectWallet(){
  try{
    setSmallStatus($('status'), 'Requesting wallet access...', 'info');
    const accts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    account = accts[0];
    const chainId = await window.ethereum.request({ method: 'eth_chainId' });

    // If not Sepolia, try to switch or add it
    if(chainId !== SEPOLIA_CHAIN_ID){
      setSmallStatus($('status'), 'Switching to Sepolia...', 'info');
      try {
        await window.ethereum.request({ method: 'wallet_switchEthereumChain', params:[{ chainId: SEPOLIA_CHAIN_ID }] });
      } catch(err) {
        if(err.code === 4902) {
          await window.ethereum.request({
            method:'wallet_addEthereumChain',
            params:[{
              chainId: SEPOLIA_CHAIN_ID,
              chainName: 'Sepolia Test Network',
              nativeCurrency: { name:'Sepolia ETH', symbol:'ETH', decimals:18 },
              rpcUrls:['https://sepolia.infura.io/v3/'],
              blockExplorerUrls:['https://sepolia.etherscan.io/']
            }]
          });
        } else throw err;
      }
    }
    await afterConnect();
  } catch(err){
    console.error(err);
    setSmallStatus($('status'), 'Connection failed: ' + (err.message||err), 'error');
  }
}

// Called once wallet is successfully connected.
// Shows UI, loads account info, analyzes wallet, and updates stake data.
async function afterConnect(){
  $('main').style.display = 'block';
  $('walletAddr').innerText = account;
  setSmallStatus($('status'), 'Connected: ' + account, 'success');

  // Run wallet analysis and load staking data
  await analyzeWalletFull();
  await loadStakeInfo();
}

// Fetch ETH price from CoinGecko for USD conversion.
// Optional but improves UX by giving users a familiar valuation metric.
async function fetchEthPrice(){
  try{
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd');
    const j = await r.json();
    return j.ethereum && j.ethereum.usd ? j.ethereum.usd : null;
  } catch(e){ return null; }
}

// Core wallet analyzer:
// - Pulls transaction history from Etherscan
// - Calculates financial health metrics (age, tx count, diversity, balance trends, gas efficiency, recency)
// - Incorporates staking contract data
// - Computes a credit score (0–100) and generates a detailed report
async function analyzeWalletFull(){
  const box = $('scoreBox');
  setSmallStatus(box, 'Fetching transaction history from Etherscan...', 'info');

  try {
    // Get Etherscan txlist (Sepolia) for this account
    const url = `${ETHERSCAN_BASE}?module=account&action=txlist&address=${account}&startblock=0&endblock=99999999&sort=asc&apikey=${ETHERSCAN_API_KEY}`;
    const resp = await fetch(url);
    const data = await resp.json();

    if(!data || data.status === '0' || !Array.isArray(data.result) || data.result.length === 0){
      // No txs on Sepolia - fallback: use balance only
      const balWei = await web3.eth.getBalance(account);
      const balEth = parseFloat(web3.utils.fromWei(balWei, 'ether'));
      const fallbackScore = Math.min(100, balEth * 12);
      currentScore = Math.round(Math.min(100, fallbackScore * 1)); 
      const summary = `⭐ Credit Score: ${currentScore}/100 (Low — no Sepolia tx history)\nCurrent balance: ${balEth.toFixed(6)} ETH\nNote: No Sepolia transactions found. Score based on balance only.`;
      box.innerText = summary;
      lastReport = summary;
      return;
    }

    const txs = data.result;
    // Compute metrics
    const firstTxTs = Number(txs[0].timeStamp);
    const lastTxTs = Number(txs[txs.length-1].timeStamp);
    const nowSec = Date.now()/1000;
    const walletAgeDays = (nowSec - firstTxTs) / (60*60*24);
    const walletAgeYears = walletAgeDays / 365.0;
    const txCount = txs.length;

    let inflow = 0, outflow = 0, totalVolume = 0;
    let balanceWalk = 0, maxBalance = 0;
    let gasSum = 0, gasCount = 0;
    const counterparties = new Set();

    for(const tx of txs){
      const valEth = parseFloat(web3.utils.fromWei(tx.value, 'ether'));
      totalVolume += Math.abs(valEth);

      if(tx.to && tx.to.toLowerCase() === account.toLowerCase()){
        inflow += valEth;
        balanceWalk += valEth;
      }
      if(tx.from && tx.from.toLowerCase() === account.toLowerCase()){
        outflow += valEth;
        balanceWalk -= valEth;
      }
      if(balanceWalk > maxBalance) maxBalance = balanceWalk;

      if(tx.gasPrice){
        gasSum += Number(tx.gasPrice);
        gasCount++;
      }

      if(tx.from && tx.from.toLowerCase() !== account.toLowerCase()) counterparties.add(tx.from.toLowerCase());
      if(tx.to && tx.to.toLowerCase() !== account.toLowerCase()) counterparties.add(tx.to.toLowerCase());
    }

    // Estimate contract interactions by sampling counterparties
    const cpArr = Array.from(counterparties);
    let contractInteractions = 0;
    const checkLimit = Math.min(cpArr.length, 20);
    for(let i=0;i<checkLimit;i++){
      try{
        const code = await web3.eth.getCode(cpArr[i]);
        if(code && code !== '0x') contractInteractions++;
      } catch(e){}
    }
    if(cpArr.length > checkLimit){
      const ratio = contractInteractions / (checkLimit || 1);
      contractInteractions = Math.round(ratio * cpArr.length);
    }

    const avgGasGwei = gasCount ? (gasSum / gasCount) / 1e9 : 0;
    const gasEfficiencyFactor = avgGasGwei ? Math.max(0, (100 / (avgGasGwei + 1))) : 1;

    const inflowOutflowRatio = (outflow === 0) ? inflow : (inflow / outflow);
    const lastActiveDaysAgo = (nowSec - lastTxTs) / (60*60*24);
    const recencyFactor = lastActiveDaysAgo <= 30 ? 1.08 : (lastActiveDaysAgo <= 90 ? 1.00 : (lastActiveDaysAgo <= 180 ? 0.95 : 0.85));

    // Current Sepolia balance
    const currentBalWei = await web3.eth.getBalance(account);
    const currentBalance = parseFloat(web3.utils.fromWei(currentBalWei, 'ether'));

    // Fetch stake info from your contract (to include in scoring)
    const stakeInfo = await contract.methods.getStake(account).call();
    const stakedAmount = parseFloat(web3.utils.fromWei(stakeInfo.amount, 'ether'));
    const stakedUnlock = Number(stakeInfo.unlockTime);

    // Now compute advanced multi-factor score (component caps)
    let score = 0;
    score += Math.min(walletAgeYears * 6, 14);         // Age (max 14)
    score += Math.min(txCount / 20, 16);               // Tx count (max 16)
    score += Math.min(cpArr.length / 8, 12);           // Counterparties diversity (max 12)
    score += Math.min(totalVolume / 2, 14);            // Total volume (max 14)
    score += Math.min(inflowOutflowRatio * 6, 12);     // Inflow/outflow ratio (max 12)
    score += Math.min(maxBalance / 0.7, 12);           // Peak balance (max 12)
    score += Math.min(currentBalance / 0.25, 10);      // Current balance cushion (max 10)
    score += Math.min((gasEfficiencyFactor / 10), 6);  // Gas efficiency (max 6)
    score += Math.min(contractInteractions / 4, 8);    // Contract interactions (max 8)

    // Apply recency multiplier
    score = score * recencyFactor;
    score = Math.max(0, Math.min(100, score));
    const rawScore = Math.round(score);

    currentScore = Math.round(Math.min(100, rawScore * 1));

    // Loan hints
    const loanLimitEth = maxBalance * 0.5 || 0;
    const ethPrice = await fetchEthPrice();
    const loanLimitUSD = ethPrice ? (loanLimitEth * ethPrice).toFixed(2) : 'N/A';
    const interestRate = Math.max(2, 22 - (currentScore / 5));
    const suggestedRepayDays = Math.max(7, Math.round(20 + (100 - currentScore)));

    // Build full report
    let report =
`⭐ Credit Score: ${currentScore}/100

Wallet age: ${walletAgeYears.toFixed(2)} years
Tx count: ${txCount}
Unique counterparties: ${cpArr.length}
Total volume (ETH): ${totalVolume.toFixed(6)}
Inflow: ${inflow.toFixed(6)} ETH | Outflow: ${outflow.toFixed(6)} ETH
Max observed balance: ${maxBalance.toFixed(6)} ETH
Current Sepolia balance: ${currentBalance.toFixed(6)} ETH
Avg gas (gwei, approx): ${avgGasGwei ? avgGasGwei.toFixed(1) : '—'}
Contract interactions (est): ${contractInteractions}
Last active: ${Math.round(lastActiveDaysAgo)} days ago`;

    if(stakedAmount > 0){
      const unlockDate = stakedUnlock > 0 ? new Date(stakedUnlock * 1000).toLocaleString() : '—';
      report += `\nStaked: ${stakedAmount.toFixed(6)} ETH (unlock: ${unlockDate})\n`;
    } else {
      report += `\nStaked: 0 ETH\n`;
    }

    report += `\nLoan hint:\n• Loan limit (approx): ${loanLimitEth.toFixed(6)} ETH (${loanLimitUSD} USD)\n• Suggested interest (annual): ${interestRate.toFixed(2)}%\n`;

    // Show report
    $('scoreBox').innerText = report;
    lastReport = report;
    // Small network hint color
    $('netHint').style.color = currentScore >= 75 ? '#059669' : (currentScore >= 45 ? '#D97706' : '#DC2626');
    $('netHint').innerText = `Evaluation: ${currentScore >= 75 ? 'High' : (currentScore >= 45 ? 'Medium' : 'Low')}`;

    // Also update stake info box
    $('stakeInfo').innerText = `Staked amount (contract): ${stakedAmount.toFixed(6)} ETH\nUnlock time: ${stakedUnlock>0?new Date(stakedUnlock*1000).toLocaleString():'—'}`;

  } catch(err){
    console.error(err);
    setSmallStatus($('scoreBox'), 'Failed to fetch/analyze txs: ' + (err.message||err), 'error');
  }
}

// Reads current staking information from the contract.
// Displays staked amount and unlock date in the UI.
async function loadStakeInfo(){
  try{
    const info = await contract.methods.getStake(account).call();
    const amt = parseFloat(web3.utils.fromWei(info.amount, 'ether'));
    const unlock = Number(info.unlockTime);
    $('stakeInfo') && ($('stakeInfo').innerText = `Staked amount (contract): ${amt.toFixed(6)} ETH\nUnlock time: ${unlock>0? new Date(unlock*1000).toLocaleString() : '—'}`);
    $('userStake') && ($('userStake').innerText = amt.toFixed(6));
    $('unlockTime') && ($('unlockTime').innerText = unlock>0?new Date(unlock*1000).toLocaleString() : '—');
  } catch(e){
    console.error(e);
    $('stakeInfo') && ($('stakeInfo').innerText = 'Failed to load stake info');
  }
}

// Live stake preview:
// Calculates the effect of amount × days on projected credit score
// and shows a simple bonus preview before user confirms.
function previewStake(){
  const amt = parseFloat($('stakeAmount').value) || 0;
  const days = parseFloat($('stakeDays').value) || 0;
  const bonus = Math.min((amt * days) / 10, 20);
  $('stakePreview').innerText = bonus > 0 ? `Projected Score: ${currentScore} → ${Math.min(100, currentScore + bonus)}  ( +${bonus.toFixed(2)} )` : '';
}

// Execute a stake transaction:
// Sends ETH along with lock period (days) to the contract.
// Updates UI and refreshes analysis after confirmation.
async function doStake(){
  const out = $('stakeStatus');
  const amt = parseFloat($('stakeAmount').value);
  const days = parseFloat($('stakeDays').value);
  if(!(amt > 0) || isNaN(days) || days < 0){ setSmallStatus(out, 'Enter valid amount and days', 'error'); return; }
  setSmallStatus(out, 'Sending stake tx — confirm in MetaMask...', 'info');
  try{
    const value = web3.utils.toWei(amt.toString(), 'ether');
    const tx = await contract.methods.stake(days).send({ from: account, value });
    setSmallStatus(out, `Staked — tx ${tx.transactionHash}`, 'success');
    await loadStakeInfo();
    await analyzeWalletFull();
  } catch(e){
    console.error(e);
    setSmallStatus(out, 'Stake failed: ' + (e.message||e), 'error');
  }
}

// Execute a withdraw transaction:
// Unlocks previously staked ETH (if lock expired).
// Refreshes staking info and credit score.
async function doWithdraw(){
  const out = $('stakeStatus');
  setSmallStatus(out, 'Sending withdraw tx — confirm in MetaMask...', 'info');
  try{
    const tx = await contract.methods.withdraw().send({ from: account });
    setSmallStatus(out, `Withdrawn — tx ${tx.transactionHash}`, 'success');
    await loadStakeInfo();
    await analyzeWalletFull();
  } catch(e){
    console.error(e);
    setSmallStatus(out, 'Withdraw failed: ' + (e.message||e), 'error');
  }
}

// Loan hint calculator:
// Uses last wallet analysis to suggest repayment terms,
// interest rate, and payment schedule based on requested inputs.
function updateLoanHint(){
  const amt = parseFloat($('borrowAmount').value) || 0;
  const deposit = parseFloat($('borrowDeposit').value) || 0;
  const years = parseFloat($('borrowYears').value) || 0;
  const freq = parseInt($('paymentsPerYear').value) || 12;
  const box = $('loanHintBox');

  // Derive loan hint using lastReport values
  // Parse loan limit & interest from lastReport
  let loanLimit = 0, suggestedInterest = 12, suggestedDays = 30;
  try{
    const matchLimit = lastReport.match(/Loan limit \(approx\): ([0-9.]+) ETH/);
    if(matchLimit) loanLimit = parseFloat(matchLimit[1]);
    const matchInterest = lastReport.match(/Suggested interest .*: ([0-9.]+)%/);
    if(matchInterest) suggestedInterest = parseFloat(matchInterest[1]);
    const matchDays = lastReport.match(/Suggested repayment days: ([0-9]+)/);
    if(matchDays) suggestedDays = parseInt(matchDays[1]);
  }catch(e){}

  if(!(amt > 0) || !(years > 0)){
    box.innerText = `Loan hint:\n• Pool loan limit (approx): ${loanLimit.toFixed(6)} ETH\n• Base suggested interest: ${suggestedInterest.toFixed(2)}%\n• Suggested repayment days (est): ${suggestedDays}`;
    return;
  }

  const principal = Math.max(0, amt - deposit);
  let adjustedInterest = suggestedInterest;
  if(amt > loanLimit) adjustedInterest += Math.min(10, ((amt - loanLimit) / Math.max(0.0001, loanLimit)) * 5);
  if(years > 2) adjustedInterest += 1.0;

  const nPeriods = Math.round(years * freq);
  const rPeriodic = adjustedInterest / 100 / freq;
  let periodicPayment = 0;
  if(rPeriodic === 0) periodicPayment = principal / (nPeriods || 1);
  else periodicPayment = principal * rPeriodic / (1 - Math.pow(1 + rPeriodic, -nPeriods));

  const totalRepay = periodicPayment * nPeriods;

  box.innerText =
`Loan hint (preview):\n• Pool loan limit (approx): ${loanLimit.toFixed(6)} ETH\n• Adjusted annual interest: ${adjustedInterest.toFixed(2)}%\n• Principal after deposit: ${principal.toFixed(6)} ETH\n• Payments: ${nPeriods} periods (${freq} / year)\n• Periodic payment: ${periodicPayment.toFixed(6)} ETH\n• Total repay (approx): ${totalRepay.toFixed(6)} ETH\n`;
  // Store preview on element
  box.dataset.preview = JSON.stringify({ amt, deposit, years, freq, principal, adjustedInterest, periodicPayment, nPeriods, totalRepay });
}

// Generates and signs a loan proposal:
// - Builds payload with borrower details, score, and repayment schedule
// - Signs it using personal.sign or eth_sign for authenticity
// - Publishes proposal to blockchain as a 0-ETH transaction to recipient
async function doGenerateLoan(){
  const out = $('borrowResult');
  const data = $('loanHintBox').dataset.preview;
  const recipient = $('borrowRecipient').value.trim();
  if(!data){ setSmallStatus(out, 'Enter loan amount and term to generate proposal', 'error'); return; }
  if(!recipient || !web3.utils.isAddress(recipient)){ setSmallStatus(out, 'Enter a valid recipient address', 'error'); return; }
  setSmallStatus(out, 'Preparing signed proposal — confirm signature in wallet...', 'info');
  try{
    const preview = JSON.parse(data);

    const payload = {
      borrower: account,
      requestedAmount: preview.amt.toString(),
      deposit: preview.deposit.toString(),
      principal: preview.principal.toString(),
      termYears: preview.years,
      paymentsPerYear: preview.freq,
      nPeriods: preview.nPeriods,
      periodicPayment: preview.periodicPayment.toString(),
      totalRepay: preview.totalRepay.toString(),
      suggestedAnnualInterest: preview.adjustedInterest.toString(),
      score: currentScore,
      loanPool: STAKING_CONTRACT_ADDRESS,
      nonce: Date.now()
    };

    // Sign payload (personal.sign) so recipient can verify borrower signature
    let signature = null;
    try{
      signature = await web3.eth.personal.sign(JSON.stringify(payload), account);
    } catch(e){
      // Some providers may not have personal.sign; try eth_sign as fallback
      try{
        signature = await web3.eth.sign(web3.utils.sha3(JSON.stringify(payload)), account);
      }catch(er){
        console.warn('Signing failed', er);
      }
    }

    const packageToSend = { payload, signature };
    const reportText = JSON.stringify(packageToSend, null, 2);
    const hex = web3.utils.utf8ToHex(reportText);

    setSmallStatus(out, 'Publishing proposal as 0-ETH tx to recipient — confirm in MetaMask...', 'info');
    const tx = await web3.eth.sendTransaction({ from: account, to: recipient, value: '0', data: hex });

    out.innerText = `Signed loan proposal published to ${recipient}\nTx: ${tx.transactionHash}\n\nPackage:\n${reportText}`;
    setSmallStatus(out, 'Signed & published — recipient can verify signature off-chain.', 'success');
  }catch(e){
    console.error(e);
    setSmallStatus(out, 'Failed to generate/publish loan proposal: ' + (e.message||e), 'error');
  }
}

// Publishes the full credit report to chain as UTF-8 hex.
// Stores it in transaction data for permanent, verifiable proof.
async function doPublish(){
  const out = $('hashStatus');
  const reportText = $('fullReport').value || lastReport || '';
  if(!reportText){ setSmallStatus(out, 'No report to publish', 'error'); return; }
  setSmallStatus(out, 'Publishing report as UTF-8 hex (confirm in MetaMask)...', 'info');
  try{
    const hex = web3.utils.utf8ToHex(reportText);
    const tx = await web3.eth.sendTransaction({ from: account, to: account, value: '0', data: hex });
    setSmallStatus(out, `Published on-chain — tx ${tx.transactionHash}`, 'success');
  } catch(e){
    console.error(e);
    setSmallStatus(out, 'Publish failed: ' + (e.message||e), 'error');
  }
}

/* Bootstrap */
window.addEventListener('DOMContentLoaded', init);