import TelegramBot from "node-telegram-bot-api";
import axios from "axios";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");const BOT_TOKEN=(process.env.BOT_TOKEN||"").trim();const ADMIN_ID=parseInt(process.env.ADMIN_ID||"0",10);const TELETHON_API_ID=parseInt(process.env.TELETHON_API_ID||"0",10);const TELETHON_API_HASH=(process.env.TELETHON_API_HASH||"").trim();const TELE_SESSION_ENV=(process.env.TELE_SESSION||process.env.TELEGRAM_SESSION||process.env.SESSION_STRING||process.env.STRING_SESSION||"").trim();const DATA_DIR=process.env.DATA_DIR||".";const PORT=Number.parseInt(process.env.PORT||"10000",10)||10000;const KEEP_ALIVE_URL=(process.env.KEEP_ALIVE_URL||"").trim();const VERSION="bocualc79 v4.3 · Stable UI";if(!fs.existsSync(DATA_DIR))fs.mkdirSync(DATA_DIR,{recursive:true});const REDEEM_STATE_FILE=path.join(DATA_DIR,"redeem_state.json");const REDEEM_LOGS_FILE=path.join(DATA_DIR,"redeem_logs.json");const GAME_ACCOUNTS_FILE=path.join(DATA_DIR,"game_accounts.json");const TELE_SESSION_FILE=path.join(DATA_DIR,"tele_session.txt");const DIV="────────────────────";const DIV2="━━━━━━━━━━━━━━━━━━━━";const RUN_MAX_SEC=3600;const RUN_INTERVAL_SEC=0.1;const FIRE_PER_CODE=12;
const DEFAULT_CHANNEL={id:"2237214360",name:"Lẩu cua game - LC79 - Kênh tặng code",username:"codelaucuagame",link:"https://t.me/codelaucuagame"};
function nickFromSession(sk){try{if(!sk)return null;const s=String(sk)+"=".repeat((4-(String(sk).length%4))%4);return JSON.parse(Buffer.from(s,"base64").toString("utf8")).nickname||null}catch{return null}}
function md5(t){return crypto.createHash("md5").update(String(t)).digest("hex")}function normalizePw(pw){pw=String(pw||"").trim();if(pw.length===32&&/^[0-9a-f]+$/i.test(pw))return pw.toLowerCase();return md5(pw)}function loadJson(p,def){try{if(fs.existsSync(p))return JSON.parse(fs.readFileSync(p,"utf8"))}catch(e){console.error("Load",p,e.message)}return def}function saveJson(p,data){try{const tmp=p+".tmp";fs.writeFileSync(tmp,JSON.stringify(data,null,2),"utf8");fs.renameSync(tmp,p);return true}catch(e){console.error("Save",p,e.message);return false}}function esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}function money(n){return Number(n||0).toLocaleString("vi-VN")}function hashStr(s){let h=0;for(let i=0;i<s.length;i++)h=(h*31+s.charCodeAt(i))|0;return String(h)}let redeemState=loadJson(REDEEM_STATE_FILE,{accounts:[],channel_id:null,channel_name:"",enabled:false,});let redeemLogs=loadJson(REDEEM_LOGS_FILE,[]);let gameAccounts=loadJson(GAME_ACCOUNTS_FILE,{});let REDEEM_ACCOUNTS=[];const ACTIVE_RUNS=new Set();const RECENT_CODES={};const SEEN_ANNOUNCE={};const userFlows={};let bootTime=Date.now();
let teleClient=null;
let teleLoginClient=null;
let teleLoginLock=false;
let teleHandlerAttached=false;
let teleAuthStatus={state:"missing",username:null,userId:null,checkedAt:null,error:null};
const channelSearchCache=new Map();
let channelCacheValue=null;
let channelCacheId="";
let channelEntityCache=null;let stats={codesSeen:0,wins:0,fails:0,lastCode:null,lastWinAt:null};function appendRedeemLog(code,account,balBefore,balAfter,amount,status){redeemLogs.push({time:new Date().toISOString().replace("T"," ").slice(0,19),code,account,balance_before:parseInt(balBefore||0,10),balance_after:parseInt(balAfter||0,10),amount:parseInt(amount||0,10),status,});if(redeemLogs.length>500)redeemLogs=redeemLogs.slice(-500);saveJson(REDEEM_LOGS_FILE,redeemLogs);console.log(`[REDEEM]${code}|${account}|${status}|+${amount}`)}function syncBalanceToStorage(username,newBalance){let u=false;for(const item of redeemState.accounts||[]){if(String(item.un||"").toLowerCase()===String(username).toLowerCase()){item.balance=parseInt(newBalance,10);u=true}}if(u)saveJson(REDEEM_STATE_FILE,redeemState);for(const k of Object.keys(gameAccounts)){const info=gameAccounts[k];if(String(info.username||"").toLowerCase()===String(username).toLowerCase()){info.money=parseInt(newBalance,10);saveJson(GAME_ACCOUNTS_FILE,gameAccounts);break}}}class RedeemAccount{constructor(un,pw,nick,owner=null,balance=0){this.un=un;this.pw=pw;this.nick=nick;this.owner=owner;this.jwt=null;this.jwtExp=0;this.balance=parseInt(balance||0,10);this.addedAt=null;this.lastRefresh=null;this.wonCode=null;this.lastSummary="NO RESPONSE";this.API_GET_ACCESS="https://apifo88daigia.tele68.com/api";this.LOGIN_URL="https://wlb.tele68.com/v1/lobby/auth/login";this.BASE_URL="https://gameapi.tele68.com";this.PARAMS="/v1/giftcode/redemption?cp=R&cl=R&pf=web&at="}headers(auth){const h={"content-type":"application/json","user-agent":"Mozilla/5.0",origin:"https://lc79.to",referer:"https://lc79.to/",accept:"application/json,text/plain,*/*",connection:"keep-alive",};if(auth)h.authorization=`Bearer ${auth}`;return h}static parseJwtExp(token){try{const payload=token.split(".")[1];const pad="=".repeat((4-(payload.length%4))%4);return JSON.parse(Buffer.from(payload+pad,"base64url").toString("utf8")).exp||0}catch{return 0}}isTokenValid(){return!!(this.jwt&&Date.now()/1000<this.jwtExp-60)}async getAccessToken(){try{const res=await axios.get(this.API_GET_ACCESS,{params:{c:"3",un:this.un,pw:this.pw,cp:"R",cl:"R",pf:"web",at:""},headers:this.headers(),timeout:7000,});const data=res.data||{};if(!data.success){this.lastError='Đăng nhập game thất bại: '+(data.message||'sai tài khoản/mật khẩu hoặc API đã đổi');return null}this.lastError=null;this.sessionKey=data.sessionKey||null;return data.accessToken}catch(e){this.lastError='Lỗi mạng khi đăng nhập: '+e.message;console.error(`[${this.un}]access:`,e.message);return null}}async refreshToken(){const at=await this.getAccessToken();if(!at)return false;try{const res=await axios.post(this.LOGIN_URL,{nickName:nickFromSession(this.sessionKey)||this.nick,accessToken:at},{headers:{"content-type":"application/json",origin:"https://lc79b.bet",referer:"https://lc79b.bet/","user-agent":"Mozilla/5.0",},timeout:7000,});const data=res.data||{};if(!data.token){this.lastError='Không nhận được token từ máy chủ';return false}this.lastError=null;this.jwt=data.token;this.jwtExp=RedeemAccount.parseJwtExp(data.token)||(Date.now()/1000+300);this.lastRefresh=Date.now()/1000;const newBal=parseInt((data.remoteLoginResp&&data.remoteLoginResp.money)||this.balance||0,10);this.balance=newBal;syncBalanceToStorage(this.un,newBal);return true}catch(e){this.lastError='Lỗi refresh: '+e.message;console.error(`[${this.un}]refresh:`,e.message);return false}}async singleRedeem(code){try{const res=await axios.post(this.BASE_URL+this.PARAMS,{code:String(code).trim(),captcha:""},{headers:this.headers(this.jwt),timeout:7000,validateStatus:()=>true});const data=res.data||{};if(res.status===200||res.status===201){let amount=data.money||data.amount||data.reward||(data.data&&data.data.money)||0;return["SUCCESS",parseInt(amount,10)||0]}if(res.status===401)return["TOKEN EXPIRED",0];return[`FAIL:${(data&&data.message)||"HTTP "+res.status}`,0]}catch{return["TIMEOUT/NETWORK",0]}}async fire(code,n=8){return Promise.all(Array.from({length:n},()=>this.singleRedeem(code)))}async redeemVariants(variants,windowSec=RUN_MAX_SEC,intervalSec=RUN_INTERVAL_SEC,stopEvent=null){
    if(!this.isTokenValid()){if(!(await this.refreshToken())){appendRedeemLog(variants[0],this.un,this.balance,this.balance,0,"LOGIN FAIL");return null}}
    const balBefore=this.balance;
    this.lastSummary="NO RESPONSE";
    const deadline=Date.now()+windowSec*1000;
    let rounds=0;let lastOutcomes={};
    while(Date.now()<deadline){
      if(stopEvent&&stopEvent.stopped)break;
      if(!this.isTokenValid())await this.refreshToken();
      rounds++;
      const outcomes={};
      await Promise.all(variants.map(async(code)=>{outcomes[code]=await this.fire(code,FIRE_PER_CODE)}));
      lastOutcomes=outcomes;
      for(const code of variants){
        const wins=(outcomes[code]||[]).filter((r)=>r[0]==="SUCCESS");
        if(wins.length){
          await this.refreshToken();
          const balAfter=this.balance;
          const totalAmt=wins.reduce((s,r)=>s+(r[1]||0),0)||Math.max(0,balAfter-balBefore);
          syncBalanceToStorage(this.un,balAfter);
          appendRedeemLog(code,this.un,balBefore,balAfter,totalAmt,"SUCCESS");
          this.wonCode=code;
          return{nick:this.nick,un:this.un,owner:this.owner,bal_before:balBefore,bal_after:balAfter,amount:totalAmt,code};
        }
      }
      const all=Object.values(outcomes).flat();
      if(all.some((r)=>r[0]==="TOKEN EXPIRED"))await this.refreshToken();
      if(stopEvent&&stopEvent.stopped)break;
      await new Promise((r)=>setTimeout(r,intervalSec*1000));
    }
    for(const code of variants){
      const summary=summarizeResults(lastOutcomes[code]||[]);
      const stopped=stopEvent&&stopEvent.stopped;
      this.lastSummary=`${summary}(${rounds}lượt)`+(stopped?" · dừng:đã có người đổi":"");
      appendRedeemLog(code,this.un,balBefore,this.balance,0,this.lastSummary);
    }
    return null;
  }}function summarizeResults(results){const counts={};for(const[st]of results)counts[st]=(counts[st]||0)+1;if(!Object.keys(counts).length)return "NO RESPONSE";return Object.entries(counts).sort((a,b)=>b[1]-a[1]).map(([st,n])=>`${st}×${n}`).join(" · ")}function codeVariants(rawText){
  if(!rawText)return[];
  const m=String(rawText).match(/Mã\s*code\s*là\s*:\s*(?:LC79\s*)?([A-Z0-9]{4,})/i);
  if(!m)return[];
  const full=m[1].trim().toUpperCase().replace(/^LC79/,"");
  const cands=[full];
  const out=[];for(const v of cands)if(v.length>=4&&!out.includes(v))out.push(v);
  return out
}
function buildRedeemAccounts(){const result=[];for(const item of redeemState.accounts||[]){if(!item||typeof item!=="object")continue;const un=String(item.un||item.username||"").trim();const pw=String(item.pw||item.password||"").trim();const nick=String(item.nick||item.nickname||un).trim();if(un&&pw){const acc=new RedeemAccount(un,pw,nick||un,item.owner,item.balance||0);acc.addedAt=item.added_at||null;result.push(acc)}}return result}function syncRedeemAccounts(){const disk=loadJson(REDEEM_STATE_FILE,null);if(disk&&typeof disk==="object"){disk.accounts=Array.isArray(disk.accounts)?disk.accounts:[];disk.channel_id=disk.channel_id??null;disk.channel_name=disk.channel_name||"";disk.enabled=!!disk.enabled;if(!disk.channel_id){disk.channel_id=DEFAULT_CHANNEL.id;disk.channel_name=DEFAULT_CHANNEL.name;disk.channel_username=DEFAULT_CHANNEL.username;disk.channel_link=DEFAULT_CHANNEL.link;disk.channel_joined=true;disk.channel_join_pending=false;}if(disk.enabled&&(disk.channel_joined!==true||disk.channel_join_pending)){disk.enabled=false;disk.enabled_safety_reset_at=new Date().toISOString();saveJson(REDEEM_STATE_FILE,disk);console.warn("[SAFETY] Auto Redeem đã tắt: cần xác minh lại trạng thái thành viên Telegram.")}redeemState=disk}REDEEM_ACCOUNTS=buildRedeemAccounts();return REDEEM_ACCOUNTS}const ANNOUNCE_RE=/Chúc mừng\s+(\S+?)(?:\s*\(\d+\))?\s+đã\s+(?:đổi thành công|nhận|lụm).*?(?:trị giá|giá trị)\s*([\d.,]+)/is;const ANNOUNCE_STOP_RE=/đã\s+(?:đổi thành công|nhận|lụm(?:\s+code)?)\b/i;async function handleAnnouncement(text){const raw=text||"";const m=raw.match(ANNOUNCE_RE);let claimedName="";let amount="";if(m){claimedName=(m[1]||"").trim();amount=(m[2]||"").trim()}else if(!ANNOUNCE_STOP_RE.test(raw)){return false}const now=Date.now()/1000;const key=claimedName?`${claimedName}|${amount}`:`_stop|${hashStr(raw)}`;if(SEEN_ANNOUNCE[key]&&now-SEEN_ANNOUNCE[key]<600)return true;SEEN_ANNOUNCE[key]=now;for(const r of ACTIVE_RUNS){if(now-r.started<1800)r.stop.stopped=true}if(ACTIVE_RUNS.size){console.log(`[ANNOUNCE]STOP · ${claimedName||"?"}· ${amount||"?"}`)}if(!claimedName){try{await bot.sendMessage(ADMIN_ID,`📢<b>Kênh báo đã có người nhận</b>\n${DIV}\n⏹ Đã dừng redeem.`,{parse_mode:"HTML"})}catch{}return true}const claimedLow=claimedName.toLowerCase();let matched=false;for(const acc of REDEEM_ACCOUNTS){const unMatch=acc.un.trim().toLowerCase()===claimedLow;if(!unMatch)continue;if(acc.wonCode!=null)continue;acc.wonCode="announcement";matched=true;stats.wins++;stats.lastWinAt=Date.now();const amtLine=amount?`\n💰 Trị giá:<b>${esc(amount)}</b>`:"";const msg=`✅<b>NHẬN CODE THÀNH CÔNG</b>\n${DIV}\n`+`🔑<code>${esc(acc.un)}</code>\n`+`📢 Theo thông báo kênh${amtLine}`;const targets=new Set([ADMIN_ID]);if(acc.owner)targets.add(acc.owner);for(const t of targets){try{await bot.sendMessage(t,msg,{parse_mode:"HTML"})}catch{}}acc.refreshToken().catch(()=>{})}if(!matched){try{await bot.sendMessage(ADMIN_ID,`📢 Kênh báo<code>${esc(claimedName)}</code>đã nhận`+(amount?` ·<b>${esc(amount)}</b>`:"")+`\n⏹ Đã dừng redeem\n⚠️ Không khớp TK nào(so theo tên đăng nhập)`,{parse_mode:"HTML"})}catch{}}return true}async function redeemAllSimultaneous(variants,msgAge=null){if(!REDEEM_ACCOUNTS.length||!variants.length)return;const started=Date.now()/1000;const stop={stopped:false};const run={stop,started,codes:[...variants]};ACTIVE_RUNS.add(run);for(const a of REDEEM_ACCOUNTS)a.wonCode=null;stats.codesSeen++;stats.lastCode=variants[0];(async()=>{const t0=Date.now();await Promise.all(REDEEM_ACCOUNTS.filter((a)=>!a.isTokenValid()).map((a)=>a.refreshToken().catch(()=>{})));const prepS=(Date.now()-t0)/1000;const winAccounts=[];const perAcc={};await Promise.all(REDEEM_ACCOUNTS.map(async(account)=>{try{const win=await account.redeemVariants(variants,28,1,stop);if(win)winAccounts.push(win);else perAcc[account.un]=account.lastSummary||"FAIL"}catch(e){perAcc[account.un]=e.message||"ERROR"}}));const ok=winAccounts.length;const total=winAccounts.reduce((s,w)=>s+(w.amount||0),0);const took=Date.now()/1000-started;ACTIVE_RUNS.delete(run);if(ok){stats.wins+=ok;stats.lastWinAt=Date.now()}else stats.fails++;let head=`📋<b>KẾT QUẢ REDEEM</b>\n${DIV2}\n`+`📝<code>${esc(variants.join("/"))}</code>\n`+`🕐 Tin cũ:${msgAge!=null?msgAge.toFixed(1)+"s":"?"}· prep ${prepS.toFixed(1)}s · tổng ${took.toFixed(1)}s\n`+`✅<b>${ok}/${REDEEM_ACCOUNTS.length}</b>· 💰<b>+${money(total)}</b>`;if(winAccounts.length){head+=`\n\n📋<b>Thành công</b>\n`+winAccounts .map((w)=>`•<code>${esc(w.un)}</code>· ${esc(w.code)}\n ${money(w.bal_before)}→<b>${money(w.bal_after)}</b><i>(+${money(w.amount)})</i>`).join("\n")}if(Object.keys(perAcc).length){head+=`\n\n⚠️<b>Chưa lụm được</b>\n`+Object.entries(perAcc).map(([n,r])=>`•<code>${esc(n)}</code>:${esc(String(r).slice(0,80))}`).join("\n")}try{await bot.sendMessage(ADMIN_ID,head,{parse_mode:"HTML"})}catch{}for(const w of winAccounts){if(w.owner&&w.owner!==ADMIN_ID){try{await bot.sendMessage(w.owner,`🎉<b>Acc của bạn lụm được code!</b>\n${DIV}\n`+`📝<code>${esc(w.code)}</code>\n`+`🔑<code>${esc(w.un)}</code>\n`+`💰 ${money(w.bal_before)}→<b>${money(w.bal_after)}</b>(+${money(w.amount)})`,{parse_mode:"HTML"})}catch{}}}})().catch((e)=>console.error("redeemAll",e.message))}async function loginAndGetInfo(u,p){try{const pwHashed=normalizePw(p);const r=(await axios.get("https://apifo88daigia.tele68.com/api",{params:{c:"3",un:u,pw:pwHashed,cp:"R",cl:"R",pf:"web",at:""},timeout:10000,})).data;if(!r.success)return{_error:"Sai tài khoản hoặc mật khẩu"};const sk=r.sessionKey+"=".repeat((4-(r.sessionKey.length%4))%4);const nn=JSON.parse(Buffer.from(sk,"base64").toString("utf8")).nickname;const r2=(await axios.post("https://wlb.tele68.com/v1/lobby/auth/login?cp=R&cl=R&pf=web&at=",{nickName:nn,accessToken:r.accessToken},{timeout:10000})).data;if(!r2.token)return{_error:"Không nhận được token(có thể kẹt phiên)"};return{token:r2.token,nickname:nn,money:parseInt((r2.remoteLoginResp&&r2.remoteLoginResp.money)||0,10),pw_hashed:pwHashed,}}catch(e){return{_error:e.message}}}function upsertRedeemAccount(un,pwHashed,nick,ownerId,balance=0){redeemState.accounts=redeemState.accounts||[];let updated=false;for(const acc of redeemState.accounts){if(String(acc.un||"").toLowerCase()===un.toLowerCase()){acc.pw=pwHashed;acc.nick=nick;acc.owner=ownerId;acc.balance=parseInt(balance||0,10);updated=true;break}}if(!updated){redeemState.accounts.push({un,pw:pwHashed,nick,owner:ownerId,balance:parseInt(balance||0,10),added_at:new Date().toLocaleString("vi-VN"),})}saveJson(REDEEM_STATE_FILE,redeemState);REDEEM_ACCOUNTS=buildRedeemAccounts()}function uptimeStr(){const s=Math.floor((Date.now()-bootTime)/1000);const h=Math.floor(s/3600);const m=Math.floor((s%3600)/60);return h>0?`${h}h ${m}m`:`${m}m ${s%60}s`}function authBadge(){
  if(teleAuthStatus.state==="authorized")return "🟢 ĐÃ KẾT NỐI";
  if(teleAuthStatus.state==="connecting")return "🟡 ĐANG KẾT NỐI";
  if(teleAuthStatus.state==="unauthorized")return "🔴 SESSION HẾT HẠN";
  if(teleAuthStatus.state==="error")return "🟠 LỖI KẾT NỐI";
  return "⚪ CHƯA ĐĂNG NHẬP";
}
function channelBadge(){
  if(redeemState.channel_join_pending)return "🟡 Đang chờ duyệt tham gia";
  if(!redeemState.channel_id)return "⚪ Chưa chọn kênh";
  if(redeemState.channel_joined===true)return "🟢 Đã tham gia";
  if(redeemState.channel_joined===false)return "🔴 Chưa tham gia";
  return "🟡 Chưa kiểm tra";
}
function teleDashboardText(){
  const who=teleAuthStatus.username?`@${esc(teleAuthStatus.username)}`:(teleAuthStatus.userId?`ID ${esc(teleAuthStatus.userId)}`:"Chưa xác định");
  const channel=redeemState.channel_name?esc(redeemState.channel_name):"Chưa đặt";
  const link=redeemState.channel_link?`\n🔗 ${esc(redeemState.channel_link)}`:"";
  const checked=teleAuthStatus.checkedAt?new Date(teleAuthStatus.checkedAt).toLocaleString("vi-VN"):"Chưa kiểm tra";
  const authError=teleAuthStatus.error?`\n⚠️ ${esc(String(teleAuthStatus.error).slice(0,180))}`:"";
  return `📡 <b>TELEGRAM SOURCE CENTER</b>\n${DIV2}\n`+
    `Tài khoản: <b>${authBadge()}</b>\n`+
    `👤 Đang đăng nhập: <b>${who}</b>\n`+
    `🕒 Kiểm tra gần nhất: <code>${esc(checked)}</code>${authError}\n${DIV}\n`+
    `📢 <b>KÊNH NHẬN CODE</b>\n`+
    `Tên kênh: <b>${channel}</b>${link}\n`+
    `Trạng thái tham gia: <b>${channelBadge()}</b>\n`+
    `⚙️ Auto redeem: <b>${redeemState.enabled?"🟢 ĐANG BẬT":"🔴 ĐANG TẮT"}</b>\n${DIV}\n`+
    `<i>Đăng nhập bằng tài khoản Telegram cá nhân. Bot sẽ kiểm tra quyền truy cập kênh và thử tham gia khi bạn đặt kênh.</i>`;
}
function homeText(){
  syncRedeemAccounts();
  const on=redeemState.enabled;
  const online=REDEEM_ACCOUNTS.filter((a)=>a.isTokenValid()).length;
  const last=lastUpdateAt?new Date(lastUpdateAt).toLocaleTimeString("vi-VN"):"Chưa có";
  return `<b>LC79 · BẢNG ĐIỀU KHIỂN</b>\n${DIV2}\n`+
    `Trạng thái: ${on?"🟢 <b>Đang bật</b>":"⚪ <b>Đang tắt</b>"}\n`+
    `Tài khoản: <b>${REDEEM_ACCOUNTS.length}</b> (token hợp lệ: <b>${online}</b>)\n`+
    `Telegram: ${authBadge()}\n`+
    `Kênh nguồn: <b>${esc(redeemState.channel_name||"Chưa đặt")}</b>\n`+
    `Cập nhật gần nhất: <code>${last}</code>\n${DIV}\n`+
    `Mã đã nhận: <b>${stats.codesSeen}</b> · Thành công: <b>${stats.wins}</b> · Thất bại: <b>${stats.fails}</b>\n`+
    (stats.lastCode?`Mã gần nhất: <code>${esc(stats.lastCode)}</code>\n`:"")+
    `${DIV}\n<i>Chọn chức năng bên dưới.</i>`;
}
function buildTokenTxt(){
  const rows=REDEEM_ACCOUNTS.map((a,i)=>`[${i+1}] ${a.nick} | ${a.un} | Số dư: ${money(a.balance)}\nToken: ${a.jwt||"CHƯA CÓ TOKEN"}\n${"-".repeat(60)}`);
  return `LỤM CODE · DANH SÁCH TOKEN\nXuất lúc: ${new Date().toLocaleString("vi-VN")}\nTổng: ${REDEEM_ACCOUNTS.length} tài khoản\n${"=".repeat(60)}\n`+rows.join("\n");
}
function mainMenu(){return{reply_markup:{inline_keyboard:[
  [{text:"⚡ AUTO REDEEM",callback_data:"rd_panel"}],
  [{text:"📡 TELEGRAM / KÊNH",callback_data:"tele_menu"}],
  [{text:"👥 TÀI KHOẢN GAME",callback_data:"rd_list"},{text:"📊 THỐNG KÊ",callback_data:"rd_stats"}],
  [{text:"🔄 LÀM MỚI",callback_data:"rd_refresh"}],
  [{text:"📄 XUẤT TOKEN (TXT)",callback_data:"export_tokens"}],
]}}}
function redeemMenu(){
  const toggle=redeemState.enabled?"🟢 TẮT AUTO":"🔴 BẬT AUTO";
  return{reply_markup:{inline_keyboard:[
    [{text:toggle,callback_data:"rd_toggle"},{text:"📡 TELE / KÊNH",callback_data:"tele_menu"}],
    [{text:"🔐 LOGIN TÀI KHOẢN",callback_data:"rd_login_acc"}],
    [{text:"📋 DANH SÁCH",callback_data:"rd_list"},{text:"➖ XOÁ TÀI KHOẢN",callback_data:"rd_delacc"}],
    [{text:"🔄 REFRESH TOKEN",callback_data:"rd_refresh"},{text:"📊 THỐNG KÊ",callback_data:"rd_stats"}],
    [{text:"🏠 MENU CHÍNH",callback_data:"home"}],
  ]}};
}
function teleMenu(){return{reply_markup:{inline_keyboard:[
  [{text:"📲 ĐĂNG NHẬP TELEGRAM",callback_data:"tele_login"}],
  [{text:"🔎 TÌM KÊNH",callback_data:"rd_searchchannel"},{text:"🔗 NHẬP LINK / USER",callback_data:"rd_setchannel"}],
  [{text:"✅ KIỂM TRA / TỰ THAM GIA",callback_data:"tele_join_check"}],
  [{text:"🔍 KIỂM TRA KÊNH (TIN CŨ)",callback_data:"chan_check"}],
  [{text:"🔄 KIỂM TRA SESSION",callback_data:"tele_check"},{text:"🚪 ĐĂNG XUẤT",callback_data:"tele_logout"}],
  [{text:"🏠 MENU CHÍNH",callback_data:"home"}],
]}}}
function panelText(){
  syncRedeemAccounts();
  const online=REDEEM_ACCOUNTS.filter((a)=>a.isTokenValid()).length;
  return `<b>AUTO REDEEM · TRẠNG THÁI</b>\n${DIV2}\n`+
    `Trạng thái: ${redeemState.enabled?"🟢 <b>Đang bật</b>":"⚪ <b>Đang tắt</b>"}\n`+
    `Telegram: ${authBadge()}\n`+
    `Kênh nguồn: <b>${esc(redeemState.channel_name||"Chưa đặt")}</b>\n`+
    `Tài khoản: <b>${REDEEM_ACCOUNTS.length}</b> (token hợp lệ: <b>${online}</b>)\n${DIV}\n`+
    `Mã đã nhận: <b>${stats.codesSeen}</b>\n`+
    `Thành công: <b>${stats.wins}</b> · Thất bại: <b>${stats.fails}</b>\n${DIV}\n`+
    `<i>Chỉ bật khi tài khoản Telegram đã tham gia kênh nguồn và kênh đã được xác minh.</i>`;
}
if(!BOT_TOKEN||!BOT_TOKEN.includes(":")||!Number.isSafeInteger(ADMIN_ID)||ADMIN_ID<=0){console.error("❌ Thiếu BOT_TOKEN hợp lệ hoặc ADMIN_ID không hợp lệ.");process.exit(1)}const bot=new TelegramBot(BOT_TOKEN,{polling:{interval:800,autoStart:true,params:{timeout:20},},});bot.on("polling_error",(e)=>console.error("[Telegram polling]",e?.message||e));bot.onText(/\/start|\/menu/,async(msg)=>{if(msg.chat.id!==ADMIN_ID){return bot.sendMessage(msg.chat.id,"⛔ Bot chỉ dành cho admin.")}await bot.sendMessage(msg.chat.id,homeText(),{parse_mode:"HTML",...mainMenu()})});bot.on("callback_query",async(q)=>{const cid=q.message.chat.id;const data=q.data;if(cid!==ADMIN_ID){return bot.answerCallbackQuery(q.id,{text:"⛔ Chỉ admin"})}await bot.answerCallbackQuery(q.id,{});const edit=(text,extra={})=>bot.editMessageText(text,{chat_id:cid,message_id:q.message.message_id,parse_mode:"HTML",link_preview_options:{is_disabled:true},...extra,}).catch((err)=>{const m=String((err&&err.message)||"");if(/message is not modified/i.test(m))return null;return bot.sendMessage(cid,text,{parse_mode:"HTML",link_preview_options:{is_disabled:true},...extra})});try{if(data==="home"){userFlows[cid]=null;return edit(homeText(),mainMenu())}if(data==="chan_check"){
  const status=await bot.sendMessage(cid,"🔍 Đang đọc tin nhắn gần nhất của kênh…");
  try{
    if(!teleClient||!teleClient.connected)await ensureTeleClient();
    const entity=await getTargetChannelEntity();
    if(!entity)throw new Error("Chưa xác định được kênh nguồn. Hãy đặt lại kênh.");
    const msgs=await teleClient.getMessages(entity,{limit:8});
    if(!msgs.length)throw new Error("Kênh chưa có tin nhắn nào đọc được.");
    const lines=msgs.map((m)=>{
      const t=String(m.message||"");
      const when=new Date((m.date||0)*1000).toLocaleString("vi-VN");
      const codes=codeVariants(t);
      const tags=[];
      if(codes.length)tags.push("MÃ: "+codes[0]);
      if(ANNOUNCE_RE.test(t))tags.push("THÔNG BÁO NHẬN CODE");
      console.log(`[KÊNH] #${m.id} ${when} | ${t.slice(0,80).replace(/\n/g," ")}`);
      return `<b>#${m.id}</b> · <code>${esc(when)}</code>\n${esc(t.slice(0,120).replace(/\n/g," "))}`+(tags.length?`\n🏷 <b>${esc(tags.join(" · "))}</b>`:"");
    });
    return bot.editMessageText(`<b>🔍 TIN NHẮN GẦN NHẤT CỦA KÊNH</b>\n${DIV}\n${lines.join("\n\n")}\n${DIV}\n<i>Có đủ tin mới ở đây nghĩa là bot đã đọc được kênh.</i>`,{chat_id:cid,message_id:status.message_id,parse_mode:"HTML",...teleMenu()});
  }catch(e){
    console.error("[KÊNH] đọc lỗi:",e.message);
    return bot.editMessageText(`❌ Không đọc được kênh: ${esc(e.message)}`,{chat_id:cid,message_id:status.message_id,parse_mode:"HTML",...teleMenu()});
  }
}
if(data==="export_tokens"){syncRedeemAccounts();if(!REDEEM_ACCOUNTS.length)return edit("📭 Chưa có tài khoản để xuất.",mainMenu());await bot.sendDocument(cid,Buffer.from(buildTokenTxt(),"utf8"),{caption:`📄 Xuất token: ${REDEEM_ACCOUNTS.length} tài khoản`,parse_mode:"HTML"},{filename:`LumCode_Tokens_${Date.now()}.txt`,contentType:"text/plain"});return}
if(data==="rd_panel")return edit(panelText(),redeemMenu());if(data==="rd_stats"){const online=REDEEM_ACCOUNTS.filter((a)=>a.isTokenValid()).length;const totalBal=REDEEM_ACCOUNTS.reduce((s,a)=>s+(a.balance||0),0);return edit(`📊<b>THỐNG KÊ</b>\n${DIV2}\n`+`⏱ Uptime:<code>${uptimeStr()}</code>\n`+`👥 TK:${REDEEM_ACCOUNTS.length}· Token OK:${online}\n`+`💰 Tổng số dư:<b>${money(totalBal)}</b>\n`+`🎁 Code thấy:${stats.codesSeen}\n`+`✅ Win:${stats.wins}· ❌ Miss:${stats.fails}\n`+(stats.lastCode?`📝 Mã gần nhất:<code>${esc(stats.lastCode)}</code>\n`:"")+(stats.lastWinAt?`🏆 Win gần nhất:${new Date(stats.lastWinAt).toLocaleString("vi-VN")}\n`:"")+`${DIV}\n<i>${VERSION}</i>`,mainMenu())}if(data==="rd_toggle"){
  syncRedeemAccounts();
  if(redeemState.enabled)redeemState.enabled=false;
  else if(!REDEEM_ACCOUNTS.length)return edit("⚠️ Chưa có tài khoản game. Hãy đăng nhập tài khoản trước.",redeemMenu());
  else if(!redeemState.channel_id)return edit("⚠️ Chưa chọn kênh nguồn. Hãy vào Telegram / Kênh để đặt kênh.",teleMenu());
  else if(teleAuthStatus.state!=="authorized"||!teleClient)return edit("⚠️ Tài khoản Telegram chưa được xác thực. Hãy kiểm tra session hoặc đăng nhập lại.",teleMenu());
  else if(redeemState.channel_joined!==true||redeemState.channel_join_pending)return edit("⚠️ Tài khoản chưa được xác minh là thành viên của kênh. Bấm KIỂM TRA / TỰ THAM GIA trước.",teleMenu());
  else redeemState.enabled=true;
  saveJson(REDEEM_STATE_FILE,redeemState);return edit(panelText(),redeemMenu());
}if(data==="rd_setchannel"){
  userFlows[cid]={step:"set_channel"};
  return edit(`🔗 <b>THÊM KÊNH NGUỒN</b>\n${DIV}\nGửi một trong các dạng sau:\n• <code>@tenkenh</code>\n• <code>https://t.me/tenkenh</code>\n• Link mời riêng tư <code>https://t.me/+...</code>\n• ID kênh (nếu tài khoản đã có trong danh sách chat)\n\nBot sẽ kiểm tra tư cách thành viên và thử tham gia tự động. Nếu kênh yêu cầu duyệt, bot sẽ báo đang chờ.\n\n<i>Gửi /cancel để huỷ.</i>`);
}if(data==="rd_searchchannel"){
  userFlows[cid]={step:"tele_channel_search"};
  return edit(`🔎 <b>TÌM KÊNH TELEGRAM</b>\n${DIV}\nNhập tên kênh hoặc username cần tìm (ít nhất 2 ký tự).\nVí dụ: <code>LC79</code> hoặc <code>kenh_code</code>.\n\n<i>Kết quả dựa trên tìm kiếm Telegram và các kênh trong danh sách chat của tài khoản. Không phải danh bạ toàn bộ Telegram.</i>\n\nGửi /cancel để huỷ.`);
}if(data==="rd_login_acc"){userFlows[cid]={step:"admin_login_game"};return edit(`🔐<b>LOGIN TÀI KHOẢN GAME</b>\n${DIV}\nGửi:\n<code>TÀI_KHOẢN MẬT_KHẨU</code>\n\n<i>Bot lưu&báo theo tên đăng nhập.</i>`)}if(data==="rd_list"){syncRedeemAccounts();if(!REDEEM_ACCOUNTS.length)return edit("📭 Chưa có tài khoản.",redeemMenu());const lines=REDEEM_ACCOUNTS.map((a,i)=>`${i+1}. ${a.isTokenValid()?"🟢":"🟡"}<code>${esc(a.un)}</code>\n`+` └ ${esc(a.nick)}· 💰<b>${money(a.balance)}</b>`);return edit(`📋<b>DANH SÁCH TÀI KHOẢN</b>\n${DIV2}\n${lines.join("\n")}\n${DIV}\nTổng:<b>${REDEEM_ACCOUNTS.length}</b>`,redeemMenu())}if(data==="rd_refresh"){syncRedeemAccounts();await edit("🔄 Đang làm mới token&số dư…");let ok=0;const errs=[];for(const acc of REDEEM_ACCOUNTS){try{if(await acc.refreshToken())ok++;else errs.push(`•<code>${esc(acc.un)}</code>: ${esc(acc.lastError||"không rõ lỗi")}`)}catch(e){errs.push(`•<code>${esc(acc.un)}</code>: ${esc(e.message)}`)}}return bot.sendMessage(cid,`✅ Refresh xong:<b>${ok}/${REDEEM_ACCOUNTS.length}</b> token OK`+(errs.length?`\n\n⚠️ <b>Lỗi:</b>\n${errs.join("\n")}`:""),{parse_mode:"HTML",...redeemMenu()})}if(data==="rd_delacc"){userFlows[cid]={step:"admin_del_redeem"};return edit(`➖<b>XOÁ TÀI KHOẢN</b>\n${DIV}\nGửi<b>tên đăng nhập</b>cần xoá.`)}if(data==="tele_menu"){
  return edit(teleDashboardText(),teleMenu());
}if(data==="tele_login"){if(!TELETHON_API_ID||!TELETHON_API_HASH)return edit("⚠️ Chưa cấu hình TELETHON_API_ID / TELETHON_API_HASH trên Render.",mainMenu());userFlows[cid]={step:"tele_login_phone"};return edit(`📲<b>ĐĂNG NHẬP TELEGRAM</b>\n${DIV}\nGửi số điện thoại có mã quốc gia.\nVí dụ: <code>+84901234567</code>\n\nSau đó bot sẽ hỏi mã OTP và mật khẩu 2FA nếu tài khoản bật xác minh hai bước.\n\n<i>Gửi /cancel để huỷ.</i>`)}if(data==="tele_logout"){
  userFlows[cid]=null;
  if(teleClient){try{await teleClient.disconnect()}catch{}teleClient=null;}
  if(teleLoginClient){try{await teleLoginClient.disconnect()}catch{}teleLoginClient=null;}
  teleHandlerAttached=false;
  teleAuthStatus={state:"missing",username:null,userId:null,checkedAt:Date.now(),error:null};
  channelCacheValue=null;channelCacheId="";channelEntityCache=null;
  try{if(fs.existsSync(TELE_SESSION_FILE))fs.unlinkSync(TELE_SESSION_FILE)}catch(e){console.error("tele logout",e.message)}
  const envSession=!!TELE_SESSION_ENV;
  return edit(envSession?"🚪 Đã ngắt kết nối. Session từ biến môi trường vẫn còn hiệu lực; hãy xoá TELE_SESSION / TELEGRAM_SESSION / SESSION_STRING trên Render nếu muốn đăng xuất hoàn toàn.":"🚪 Đã đăng xuất và xoá file session đã lưu.",teleMenu());
}
if(data==="tele_check"){
  const status=await bot.sendMessage(cid,"🔄 Đang xác minh session Telegram trực tiếp…");
  try{await ensureTeleClient();await startTeleListener();return bot.editMessageText(`✅ <b>SESSION HỢP LỆ</b>\n${DIV}\nTài khoản: <b>${esc(teleAuthStatus.username?"@"+teleAuthStatus.username:String(teleAuthStatus.userId))}</b>\nUser ID: <code>${esc(teleAuthStatus.userId||"-")}</code>\nThời gian: <code>${new Date(teleAuthStatus.checkedAt).toLocaleString("vi-VN")}</code>`,{chat_id:cid,message_id:status.message_id,parse_mode:"HTML",...teleMenu()});}
  catch(e){return bot.editMessageText(`❌ <b>SESSION CHƯA SẴN SÀNG</b>\n${DIV}\n${esc(telegramErrorText(e))}`,{chat_id:cid,message_id:status.message_id,parse_mode:"HTML",...teleMenu()});}
}
if(data==="tele_join_check"){
  const status=await bot.sendMessage(cid,"🔎 Đang kiểm tra quyền truy cập và tư cách thành viên…");
  try{
    await ensureTeleClient();
    if(!redeemState.channel_link&&!redeemState.channel_id)throw new Error("Bạn chưa đặt kênh. Hãy dán link hoặc tìm kênh trước.");
    let result;
    if(redeemState.channel_link)result=await configureChannelFromInput(redeemState.channel_link);
    else result=await configureChannelFromInput(String(redeemState.channel_id));
    const message=result.pending?"🟡 Yêu cầu tham gia đã gửi, đang chờ quản trị viên duyệt.":`✅ Đã xác minh tham gia kênh <b>${esc(redeemState.channel_name)}</b>.`;
    return bot.editMessageText(message,{chat_id:cid,message_id:status.message_id,parse_mode:"HTML",...teleMenu()});
  }catch(e){return bot.editMessageText(`❌ Không kiểm tra được: ${esc(telegramErrorText(e))}`,{chat_id:cid,message_id:status.message_id,parse_mode:"HTML",...teleMenu()});}
}
if(data.startsWith("ch_pick_")){
  const index=Number(data.slice("ch_pick_".length));
  const results=channelSearchCache.get(String(cid))||[];
  const entity=Number.isInteger(index)?results[index]:null;
  if(!entity)return edit("⚠️ Kết quả tìm kiếm đã hết hạn. Hãy tìm lại.",teleMenu());
  const status=await bot.sendMessage(cid,"⏳ Đang kiểm tra kênh và thử tham gia…");
  try{
    await ensureTeleClient();
    const link=entity.username?`https://t.me/${entity.username}`:"";
    const result=await checkJoinEntity(entity,link);
    const resultText=result.pending?`🟡 <b>ĐÃ GỬI YÊU CẦU THAM GIA</b>\n${DIV}\n📢 <b>${esc(channelEntityName(entity))}</b>\nTelegram đang chờ quản trị viên duyệt. Auto redeem đã tắt.`:`✅ <b>ĐÃ CHỌN KÊNH</b>\n${DIV}\n📢 <b>${esc(channelEntityName(entity))}</b>\n${link?`🔗 ${esc(link)}\n`:""}🟢 Tài khoản đã tham gia. Kênh đã được lưu làm nguồn nhận code.`;
    return bot.editMessageText(resultText,{chat_id:cid,message_id:status.message_id,parse_mode:"HTML",...teleMenu()});
  }catch(e){return bot.editMessageText(`❌ Không thể chọn kênh: ${esc(telegramErrorText(e))}`,{chat_id:cid,message_id:status.message_id,parse_mode:"HTML",...teleMenu()});}
}
}catch(e){console.error("callback",e.message)} });bot.on("message",async(msg)=>{const cid=msg.chat.id;if(cid!==ADMIN_ID)return;if(!msg.text)return;const flow=userFlows[cid];if(!flow||!flow.step)return;const value=msg.text.trim();if(["huy","huỷ","cancel","/cancel"].includes(value.toLowerCase())){userFlows[cid]=null;if(teleLoginClient){try{await teleLoginClient.disconnect()}catch{}teleLoginClient=null}return bot.sendMessage(cid,"↩️ Đã huỷ thao tác.",{parse_mode:"HTML",...mainMenu()})}if(value.startsWith("/"))return;if(flow.step==="tele_login_phone"){
  const status=await bot.sendMessage(cid,"⏳ Đang yêu cầu mã đăng nhập Telegram…");
  try{await beginTeleLogin(cid,value);return bot.editMessageText("📩 Telegram đã tạo yêu cầu mã đăng nhập.\n\nTelegram quyết định kênh gửi mã. Loại gửi thực tế: <code>"+esc(userFlows[cid]?.codeType||"Telegram")+"</code>\n\nNhập OTP tại đây. Kiểm tra chat dịch vụ Telegram nếu chưa thấy mã. Không chia sẻ mã này cho ai.",{chat_id:cid,message_id:status.message_id,parse_mode:"HTML",...mainMenu()})}
  catch(e){if(teleLoginClient){try{await teleLoginClient.disconnect()}catch{}teleLoginClient=null}userFlows[cid]=null;return bot.editMessageText("❌ Không gửi được mã: "+esc(e.message),{chat_id:cid,message_id:status.message_id,parse_mode:"HTML",...mainMenu()})}
}
if(flow.step==="tele_login_code"){
  try{await bot.deleteMessage(cid,msg.message_id)}catch{}
  const status=await bot.sendMessage(cid,"🔐 Đang xác minh mã OTP…");
  try{
    if(!teleLoginClient)throw new Error("Phiên đăng nhập đã hết hạn. Hãy bắt đầu lại.");
    await teleLoginClient.invoke(new Api.auth.SignIn({
      phoneNumber:flow.phone,
      phoneCodeHash:flow.phoneCodeHash,
      phoneCode:value.replace(/\s/g,""),
    }));
    return finishTeleLogin(cid,teleLoginClient,status.message_id);
  }catch(e){
    const msg=String(e.errorMessage||e.message||"");
    if(/SESSION_PASSWORD_NEEDED|password is required/i.test(msg)){
      userFlows[cid]={...flow,step:"tele_login_2fa"};
      return bot.editMessageText("🔒 Tài khoản đã bật xác minh hai bước (2FA).\nHãy nhập mật khẩu 2FA Telegram của bạn. Mật khẩu chỉ dùng để hoàn tất đăng nhập và không được lưu.",{chat_id:cid,message_id:status.message_id,...mainMenu()});
    }
    return bot.editMessageText("❌ OTP chưa hợp lệ hoặc đã hết hạn: "+esc(msg)+"\nGửi lại mã mới hoặc /cancel để huỷ.",{chat_id:cid,message_id:status.message_id,parse_mode:"HTML",...mainMenu()});
  }
}
if(flow.step==="tele_login_2fa"){
  try{await bot.deleteMessage(cid,msg.message_id)}catch{}
  const status=await bot.sendMessage(cid,"🔐 Đang xác minh mật khẩu 2FA…");
  try{
    if(!teleLoginClient)throw new Error("Phiên đăng nhập đã hết hạn. Hãy bắt đầu lại.");
    await teleLoginClient.signInWithPassword({apiId:TELETHON_API_ID,apiHash:TELETHON_API_HASH},{password:async()=>value,onError:async()=>true});
    return finishTeleLogin(cid,teleLoginClient,status.message_id);
  }catch(e){return bot.editMessageText("❌ Xác minh 2FA thất bại: "+esc(e.errorMessage||e.message)+"\nThử lại mật khẩu hoặc /cancel.",{chat_id:cid,message_id:status.message_id,parse_mode:"HTML",...mainMenu()})}
}
if(flow.step==="tele_channel_search"){
  const status=await bot.sendMessage(cid,"🔎 Đang tìm kênh trên Telegram…");
  try{
    const results=await searchTelegramChannels(value);
    userFlows[cid]=null;
    if(!results.length)return bot.editMessageText("Không tìm thấy kênh phù hợp. Hãy thử username chính xác hoặc dán link t.me.",{chat_id:cid,message_id:status.message_id,...teleMenu()});
    channelSearchCache.set(String(cid),results);
    const keyboard=results.map((entity,i)=>[{text:`${i+1}. ${(channelEntityName(entity)+ (entity.username?" · @"+entity.username:"" )).slice(0,55)}`,callback_data:`ch_pick_${i}`}]);
    keyboard.push([{text:"🔎 Tìm lại",callback_data:"rd_searchchannel"},{text:"↩️ Nhập link",callback_data:"rd_setchannel"}]);
    keyboard.push([{text:"🏠 Menu Telegram",callback_data:"tele_menu"}]);
    return bot.editMessageText(`🔎 <b>KẾT QUẢ TÌM KÊNH</b>\n${DIV}\nTìm thấy <b>${results.length}</b> kết quả. Chọn đúng kênh bạn muốn dùng:\n\n<i>Bot sẽ kiểm tra tư cách thành viên và thử tham gia nếu chưa vào.</i>`,{chat_id:cid,message_id:status.message_id,parse_mode:"HTML",reply_markup:{inline_keyboard:keyboard}});
  }catch(e){userFlows[cid]=null;return bot.editMessageText(`❌ Không tìm được kênh: ${esc(telegramErrorText(e))}`,{chat_id:cid,message_id:status.message_id,parse_mode:"HTML",...teleMenu()});}
}
if(flow.step==="set_channel"){
  const status=await bot.sendMessage(cid,"🔎 Đang kiểm tra kênh và quyền tham gia…");
  try{
    const result=await configureChannelFromInput(value);
    userFlows[cid]=null;
    const msg=result.pending?`🟡 <b>ĐÃ GỬI YÊU CẦU THAM GIA</b>\n${DIV}\nKênh: <b>${esc(redeemState.channel_name||"Kênh riêng tư")}</b>\nTelegram cần quản trị viên duyệt. Auto redeem đã được tắt cho đến khi xác minh thành viên.`:`✅ <b>ĐÃ XÁC MINH VÀ ĐẶT KÊNH</b>\n${DIV}\n📢 Kênh: <b>${esc(redeemState.channel_name)}</b>\n👤 Tài khoản: <b>${esc(teleAuthStatus.username?"@"+teleAuthStatus.username:String(teleAuthStatus.userId||"Đã đăng nhập"))}</b>\n🟢 Trạng thái: <b>Đã tham gia kênh</b>\n\nBạn có thể bật Auto Redeem.`;
    return bot.editMessageText(msg,{chat_id:cid,message_id:status.message_id,parse_mode:"HTML",...teleMenu()});
  }catch(e){userFlows[cid]=null;return bot.editMessageText(`❌ <b>KHÔNG THỂ ĐẶT KÊNH</b>\n${DIV}\n${esc(telegramErrorText(e))}\n\nKiểm tra username/link hoặc thử tìm kênh bằng nút 🔎 TÌM KÊNH.`,{chat_id:cid,message_id:status.message_id,parse_mode:"HTML",...teleMenu()});}
}if(flow.step==="admin_login_game"){const parts=value.split(/\s+/);if(parts.length<2){return bot.sendMessage(cid,"⚠️ Gửi:<code>TÀI_KHOẢN MẬT_KHẨU</code>",{parse_mode:"HTML",})}const un=parts[0];const pw=parts.slice(1).join(" ");const status=await bot.sendMessage(cid,`🔄 Đang đăng nhập<code>${esc(un)}</code>…`,{parse_mode:"HTML",});const res=await loginAndGetInfo(un,pw);if(res._error){userFlows[cid]=null;return bot.editMessageText(`❌ ${esc(res._error)}`,{chat_id:cid,message_id:status.message_id,parse_mode:"HTML",...redeemMenu(),})}upsertRedeemAccount(un,res.pw_hashed,res.nickname,cid,res.money);userFlows[cid]=null;return bot.editMessageText(`✅<b>ĐĂNG NHẬP THÀNH CÔNG</b>\n${DIV2}\n`+`🔑 Tên đăng nhập:<code>${esc(un)}</code>\n`+`👤 Nickname:<b>${esc(res.nickname)}</b>\n`+`💰 Số dư:<b>${money(res.money)}</b>\n`+`⚡ Đã sẵn sàng lụm code.`,{chat_id:cid,message_id:status.message_id,parse_mode:"HTML",...redeemMenu()})}if(flow.step==="admin_del_redeem"){const key=value.toLowerCase();const before=(redeemState.accounts||[]).length;redeemState.accounts=(redeemState.accounts||[]).filter((a)=>String(a.un||"").toLowerCase()!==key&&String(a.nick||"").toLowerCase()!==key);saveJson(REDEEM_STATE_FILE,redeemState);REDEEM_ACCOUNTS=buildRedeemAccounts();userFlows[cid]=null;const removed=before-redeemState.accounts.length;return bot.sendMessage(cid,removed?`✅ Đã xoá<b>${removed}</b>tài khoản.`:"⚠️ Không tìm thấy.",{parse_mode:"HTML",...redeemMenu()})}});function saveTeleSession(session){
  fs.mkdirSync(DATA_DIR,{recursive:true});
  const tmp=TELE_SESSION_FILE+".tmp";
  fs.writeFileSync(tmp,String(session),{encoding:"utf8",mode:0o600});
  fs.renameSync(tmp,TELE_SESSION_FILE);
  try{fs.chmodSync(TELE_SESSION_FILE,0o600)}catch{}
}
async function finishTeleLogin(chatId, client, statusMessageId){
  saveTeleSession(client.session.save());
  if(teleClient && teleClient!==client){try{await teleClient.disconnect()}catch{}}
  teleClient=client;
  teleHandlerAttached=false;
  teleLoginClient=null;
  userFlows[chatId]=null;
  try{
    const listenerReady=await startTeleListener();
    if(!listenerReady)throw new Error(teleAuthStatus.error||"Không khởi động được trình nghe Telegram. Hãy kiểm tra API ID/HASH và log máy chủ.");
    await bot.editMessageText(`✅ <b>ĐĂNG NHẬP TELEGRAM THÀNH CÔNG</b>\n${DIV2}\n👤 Tài khoản: <b>${esc(teleAuthStatus.username?"@"+teleAuthStatus.username:String(teleAuthStatus.userId||"Đã xác thực"))}</b>\n🔐 Session đã được lưu an toàn trong DATA_DIR.\n\nBạn có thể tìm kênh hoặc dán link kênh ngay bây giờ.`,{chat_id:chatId,message_id:statusMessageId,parse_mode:"HTML",...teleMenu()});
  }catch(e){
    await bot.editMessageText(`⚠️ Đã xác thực OTP nhưng trình nghe chưa sẵn sàng: ${esc(e.message||e)}`,{chat_id:chatId,message_id:statusMessageId,parse_mode:"HTML",...teleMenu()}).catch(()=>{});
  }
}
async function beginTeleLogin(chatId, phone){
  if(teleLoginLock)throw new Error("Đang có một yêu cầu đăng nhập khác. Hãy chờ hoặc /cancel.");
  if(!TELETHON_API_ID || !TELETHON_API_HASH) throw new Error("Thiếu TELETHON_API_ID hoặc TELETHON_API_HASH trong Render Environment.");
  const normalized=String(phone||"").replace(/[\s()-]/g,"");
  if(!/^\+?[0-9]{7,15}$/.test(normalized)) throw new Error("Số điện thoại chưa đúng định dạng. Ví dụ: +84901234567");
  teleLoginLock=true;
  try{
    if(teleLoginClient){try{await teleLoginClient.disconnect()}catch{}teleLoginClient=null;}
    const client=new TelegramClient(new StringSession(""),TELETHON_API_ID,TELETHON_API_HASH,{connectionRetries:5,useWSS:false,catchUp:true});
    try{
      await client.connect();
      const sent=await client.sendCode({apiId:TELETHON_API_ID,apiHash:TELETHON_API_HASH},normalized);
      if(!sent || !sent.phoneCodeHash) throw new Error("Telegram không trả phoneCodeHash. Kiểm tra API_ID/API_HASH, số điện thoại và log Render.");
      teleLoginClient=client;
      userFlows[chatId]={step:"tele_login_code",phone:normalized,phoneCodeHash:sent.phoneCodeHash,isCodeViaApp:!!sent.isCodeViaApp,codeType:sent.isCodeViaApp?"Ứng dụng Telegram":"SMS/điện thoại"};
      return sent;
    }catch(error){try{await client.disconnect()}catch{}throw error;}
  }finally{teleLoginLock=false;}
}
function normalizeChannelId(value){return String(value??"").trim().replace(/^-100/,"").replace(/^-/ ,"");}
function telegramErrorText(error){
  const code=String(error?.errorMessage||error?.message||error||"");
  if(/USER_NOT_PARTICIPANT|CHANNEL_PRIVATE/i.test(code))return "Tài khoản chưa tham gia hoặc kênh đang ở chế độ riêng tư.";
  if(/INVITE_REQUEST_SENT/i.test(code))return "Đã gửi yêu cầu tham gia. Cần quản trị viên kênh duyệt.";
  if(/USER_BANNED_IN_CHANNEL/i.test(code))return "Tài khoản đã bị cấm khỏi kênh nên không thể tự tham gia.";
  if(/USER_ALREADY_PARTICIPANT/i.test(code))return "Tài khoản đã là thành viên của kênh.";
  if(/INVITE_HASH_EXPIRED|INVITE_HASH_INVALID/i.test(code))return "Link mời đã hết hạn hoặc không hợp lệ.";
  if(/CHANNELS_TOO_MUCH/i.test(code))return "Tài khoản đã tham gia quá nhiều kênh/nhóm. Hãy rời bớt kênh rồi thử lại.";
  if(/USERNAME_INVALID|USERNAME_NOT_OCCUPIED/i.test(code))return "Không tìm thấy username kênh này.";
  if(/FLOOD_WAIT/i.test(code))return `Telegram giới hạn thao tác. Hãy thử lại sau: ${code}`;
  if(/CHAT_ADMIN_REQUIRED|CHANNEL_INVALID/i.test(code))return "Telegram không cấp quyền truy cập kênh này cho tài khoản hiện tại.";
  return code.slice(0,240)||"Lỗi Telegram không xác định.";
}
function channelEntityName(entity){return String(entity?.title||entity?.username||entity?.firstName||"Telegram Channel");}
function isChannelEntity(entity){return !!entity && (entity.className==="Channel" || entity.broadcast!==undefined || entity.megagroup!==undefined);}
function parseTelegramChannelInput(input){
  const raw=String(input||"").trim();
  if(!raw)throw new Error("Bạn chưa nhập link hoặc username kênh.");
  const tg=raw.match(/^tg:\/\/join\?invite=([A-Za-z0-9_-]+)/i);
  if(tg)return{kind:"invite",hash:tg[1],link:raw};
  let pathPart="";
  if(/^https?:\/\//i.test(raw)||/^(?:www\.)?(?:t\.me|telegram\.me)\//i.test(raw)){
    const url=new URL(raw.startsWith("http")?raw:`https://${raw}`);
    if(!/(^|\.)t\.me$|(^|\.)telegram\.me$/i.test(url.hostname))throw new Error("Chỉ hỗ trợ link t.me hoặc telegram.me.");
    pathPart=url.pathname.replace(/^\/+|\/+$/g,"");
  }else if(/^@/.test(raw)){pathPart=raw.slice(1)}
  else if(/^-?\d+$/.test(raw))return{kind:"id",id:raw,link:raw};
  else pathPart=raw.replace(/^\/+|\/+$/g,"");
  const parts=pathPart.split("/").filter(Boolean);
  if(!parts.length)throw new Error("Link Telegram không hợp lệ.");
  if(parts[0].startsWith("+")&&parts[0].length>1)return{kind:"invite",hash:parts[0].slice(1),link:raw};
  if(parts[0].toLowerCase()==="joinchat"&&parts[1])return{kind:"invite",hash:parts[1],link:raw};
  if(parts[0].toLowerCase()==="c"&&parts[1])return{kind:"id",id:`-100${parts[1]}`,link:raw};
  if(parts[0].toLowerCase()==="s"&&parts[1])return{kind:"username",username:parts[1].replace(/^@/,""),link:raw};
  const username=parts[0].replace(/^@/,"");
  if(!/^[A-Za-z0-9_]{4,}$/.test(username))throw new Error("Username kênh chưa đúng. Dùng @username hoặc link https://t.me/username.");
  return{kind:"username",username,link:raw.startsWith("@")?`https://t.me/${username}`:raw};
}
async function ensureTeleClient(){
  if(!TELETHON_API_ID||!TELETHON_API_HASH)throw new Error("Thiếu TELETHON_API_ID / TELETHON_API_HASH trong Environment.");
  if(!teleClient){
    const sessionStr=loadTeleSession();
    if(!sessionStr)throw new Error("Chưa có session Telegram. Hãy đăng nhập bằng SĐT trước.");
    teleClient=new TelegramClient(new StringSession(sessionStr),TELETHON_API_ID,TELETHON_API_HASH,{connectionRetries:8,useWSS:false,catchUp:true});
  }
  teleAuthStatus.state="connecting";
  try{
    await teleClient.connect();
    if(!(await teleClient.checkAuthorization())){
      try{await teleClient.disconnect()}catch{}
      teleClient=null;teleHandlerAttached=false;
      teleAuthStatus={state:"unauthorized",username:null,userId:null,checkedAt:Date.now(),error:"Session không hợp lệ hoặc đã hết hạn."};
      throw new Error("Session Telegram không hợp lệ hoặc đã hết hạn. Hãy đăng nhập lại.");
    }
    const me=await teleClient.getMe();
    teleAuthStatus={state:"authorized",username:me?.username||null,userId:me?.id?.toString?.()||String(me?.id||""),checkedAt:Date.now(),error:null};
    return me;
  }catch(e){
    if(teleAuthStatus.state!=="unauthorized")teleAuthStatus={state:"error",username:null,userId:null,checkedAt:Date.now(),error:telegramErrorText(e)};
    throw e;
  }
}
async function findDialogChannelById(id){
  const wanted=normalizeChannelId(id);
  try{
    for await(const dialog of teleClient.iterDialogs({limit:500})){
      const entity=dialog?.entity;
      if(entity && normalizeChannelId(entity.id?.toString?.()??entity.id)===wanted)return entity;
    }
  }catch(e){console.warn("[TELE] dialog search:",e.message)}
  return null;
}
async function getTargetChannelEntity(){
  if(!teleClient||!redeemState.channel_id)return null;
  const configured=String(redeemState.channel_id).trim();
  if(channelCacheValue===configured&&channelEntityCache)return channelEntityCache;
  let entity=null;
  if(/^@/.test(configured))entity=await teleClient.getEntity(configured);
  else entity=await findDialogChannelById(configured);
  if(!entity && /^-?\d+$/.test(configured))entity=await teleClient.getEntity(Number(configured)).catch(()=>null);
  if(!entity && redeemState.channel_username)entity=await teleClient.getEntity('@'+redeemState.channel_username).catch(()=>null);
  if(entity){channelCacheValue=configured;channelCacheId=normalizeChannelId(entity.id?.toString?.()??entity.id);channelEntityCache=entity;}
  return entity;
}
async function getTargetChannelId(){
  const entity=await getTargetChannelEntity();
  return entity?normalizeChannelId(entity.id?.toString?.()??entity.id):"";
}
async function checkChannelMembership(entity){
  const inputChannel=await teleClient.getInputEntity(entity);
  try{
    await teleClient.invoke(new Api.channels.GetParticipant({channel:inputChannel,participant:new Api.InputPeerSelf()}));
    return true;
  }catch(e){
    const code=String(e?.errorMessage||e?.message||"");
    if(/USER_NOT_PARTICIPANT|CHANNEL_PRIVATE|PARTICIPANT_ID_INVALID/i.test(code))return false;
    throw e;
  }
}
function persistChannel(entity,link,joined=true){
  const id=entity?.id?.toString?.()??String(entity?.id||"");
  redeemState.channel_id=id;
  redeemState.channel_name=channelEntityName(entity);
  redeemState.channel_username=entity?.username||"";
  redeemState.channel_link=link|| (entity?.username?`https://t.me/${entity.username}`:"");
  redeemState.channel_joined=!!joined;
  redeemState.channel_join_pending=false;
  redeemState.channel_checked_at=new Date().toISOString();
  channelCacheValue=String(id);channelCacheId=normalizeChannelId(id);channelEntityCache=entity;
  saveJson(REDEEM_STATE_FILE,redeemState);
}
async function checkJoinEntity(entity,link){
  if(!isChannelEntity(entity))throw new Error("Địa chỉ này không phải kênh/siêu nhóm Telegram hợp lệ.");
  let joined=await checkChannelMembership(entity);
  if(!joined){
    try{
      await teleClient.invoke(new Api.channels.JoinChannel({channel:await teleClient.getInputEntity(entity)}));
    }catch(e){
      const code=String(e?.errorMessage||e?.message||"");
      if(/USER_ALREADY_PARTICIPANT/i.test(code)){
        // A race may have joined between the membership check and JoinChannel.
        // Verify membership again below instead of treating this as a failure.
      }else if(/INVITE_REQUEST_SENT/i.test(code)){
        redeemState.channel_id=entity?.id?.toString?.()??String(entity?.id||"");
        redeemState.channel_name=channelEntityName(entity);redeemState.channel_username=entity?.username||"";redeemState.channel_link=link||"";
        redeemState.channel_joined=false;redeemState.channel_join_pending=true;redeemState.enabled=false;
        channelCacheValue=String(redeemState.channel_id);channelCacheId=normalizeChannelId(redeemState.channel_id);channelEntityCache=entity;
        saveJson(REDEEM_STATE_FILE,redeemState);
        return{joined:false,pending:true,entity};
      }else{
        throw e;
      }
    }
    joined=await checkChannelMembership(entity);
  }
  if(!joined)throw new Error("Đã gửi lệnh tham gia nhưng Telegram chưa xác nhận tài khoản là thành viên. Hãy kiểm tra lại trong Telegram.");
  persistChannel(entity,link,true);
  return{joined:true,pending:false,entity};
}
async function configureChannelFromInput(input){
  await ensureTeleClient();
  const parsed=parseTelegramChannelInput(input);
  if(parsed.kind==="invite"){
    let preview;
    try{preview=await teleClient.invoke(new Api.messages.CheckChatInvite({hash:parsed.hash}));}
    catch(e){throw new Error(telegramErrorText(e));}
    if(preview?.className==="ChatInviteAlready"&&preview.chat){
      const entity=await teleClient.getEntity(preview.chat);
      const result=await checkJoinEntity(entity,parsed.link);
      return{...result,link:parsed.link};
    }
    try{
      const joined=await teleClient.invoke(new Api.messages.ImportChatInvite({hash:parsed.hash}));
      const chat=joined?.chats?.[0];
      if(!chat)throw new Error("Telegram không trả thông tin kênh sau khi tham gia.");
      const entity=await teleClient.getEntity(chat);
      const result=await checkJoinEntity(entity,parsed.link);
      return{...result,link:parsed.link};
    }catch(e){
      const code=String(e?.errorMessage||e?.message||"");
      if(/INVITE_REQUEST_SENT/i.test(code)){
        redeemState.channel_id=null;redeemState.channel_name="Đang chờ duyệt";redeemState.channel_link=parsed.link;
        redeemState.channel_joined=false;redeemState.channel_join_pending=true;redeemState.enabled=false;saveJson(REDEEM_STATE_FILE,redeemState);
        return{joined:false,pending:true,entity:null,link:parsed.link};
      }
      throw new Error(telegramErrorText(e));
    }
  }
  let entity=null;
  if(parsed.kind==="username")entity=await teleClient.getEntity(parsed.username.startsWith("@")?parsed.username:`@${parsed.username}`);
  else entity=await findDialogChannelById(parsed.id);
  if(!entity&&parsed.kind==="id")entity=await teleClient.getEntity(Number(parsed.id)).catch(()=>null);
  if(!entity)throw new Error("Không tìm thấy kênh. Với kênh riêng tư, hãy dùng link mời hoặc tài khoản phải có kênh trong danh sách chat.");
  const result=await checkJoinEntity(entity,parsed.link);
  return{...result,link:parsed.link};
}
async function searchTelegramChannels(query){
  await ensureTeleClient();
  const q=String(query||"").trim().replace(/^@/,"");
  if(q.length<2)throw new Error("Nhập ít nhất 2 ký tự để tìm kênh.");
  const found=[];const seen=new Set();
  const add=(entity)=>{
    if(!isChannelEntity(entity))return;
    const id=String(entity.id?.toString?.()??entity.id??"");
    if(!id||seen.has(id))return;seen.add(id);
    found.push(entity);
  };
  try{
    const result=await teleClient.invoke(new Api.contacts.Search({q,limit:20}));
    for(const entity of (result?.chats||[]))add(entity);
  }catch(e){console.warn("[TELE] contacts.Search:",e.message)}
  try{
    for await(const dialog of teleClient.iterDialogs({limit:300})){
      const entity=dialog?.entity;const hay=`${entity?.title||""} ${entity?.username||""}`.toLowerCase();
      if(hay.includes(q.toLowerCase()))add(entity);
      if(found.length>=20)break;
    }
  }catch(e){console.warn("[TELE] dialog search:",e.message)}
  return found.slice(0,10);
}
function loadTeleSession(){
  // A fresh session created by OTP login must take precedence over an older env value.
  try{if(fs.existsSync(TELE_SESSION_FILE)){const saved=fs.readFileSync(TELE_SESSION_FILE,"utf8").trim();if(saved)return saved;}}catch(e){console.error("[TELE] Read session:",e.message)}
  return TELE_SESSION_ENV||"";
}
let lastDiagAt=0;
async function diag(text){const now=Date.now();if(now-lastDiagAt<60000)return;lastDiagAt=now;try{await bot.sendMessage(ADMIN_ID,'⚠️ '+text,{parse_mode:'HTML'})}catch{}}
async function startTeleListener(){
  if(!TELETHON_API_ID||!TELETHON_API_HASH){console.warn("Thiếu TELETHON_API_ID/HASH — bỏ qua canh kênh.");return false;}
  if(!teleClient&&!loadTeleSession()){teleAuthStatus={state:"missing",username:null,userId:null,checkedAt:Date.now(),error:null};console.warn("Chưa có Telegram StringSession.");return false;}
  try{
    await ensureTeleClient();
    await teleClient.getDialogs({limit:500}).then((d)=>console.log("[TELE] đã nạp "+d.length+" hội thoại")).catch((e)=>console.warn("[TELE] getDialogs:",e.message));
    if(!teleHandlerAttached){
      const handler=async(event)=>{lastUpdateAt=Date.now();try{console.log("[TELE-RAW] chat="+(event.chatId??"?")+" text="+String((event.message&&event.message.message)||"").slice(0,40).replace(/\n/g," "))}catch{}
        try{
          if(!redeemState.enabled||redeemState.channel_id==null||redeemState.channel_joined!==true||redeemState.channel_join_pending){if(codeVariants(event.message&&event.message.message).length)diag('Thấy mã nhưng Auto redeem đang TẮT hoặc kênh chưa xác minh');return;}
          const chatId=event.chatId!=null?String(event.chatId):"";
          const targetChannelId=await getTargetChannelId();
          if(!targetChannelId||normalizeChannelId(chatId)!==targetChannelId){if(codeVariants(event.message&&event.message.message).length)diag(`Thấy mã nhưng không phải kênh nguồn (chat ${esc(chatId)} ≠ ${esc(redeemState.channel_name)})`);return;}
          const text=event.message&&event.message.message;
          if(!text)return;
          if(await handleAnnouncement(text))return;
          const variants=codeVariants(text);
          if(!variants.length)return;
          const now=Date.now()/1000;
          for(const k of Object.keys(RECENT_CODES)){if(now-RECENT_CODES[k]>3600)delete RECENT_CODES[k];}
          if(variants.some((v)=>RECENT_CODES[v]))return;
          for(const v of variants)RECENT_CODES[v]=now;
          let msgAge=null;
          try{const dateValue=event.message.date;const postedAt=dateValue instanceof Date?dateValue.getTime()/1000:Number(dateValue);if(Number.isFinite(postedAt))msgAge=now-postedAt}catch{}
          console.log(`[TELE] code=${variants.join(",")} age=${msgAge}`);
          try{await bot.sendMessage(ADMIN_ID,`📥 <b>PHÁT HIỆN MÃ MỚI</b>\n${DIV}\n🎁 <code>${esc(variants.join("/"))}</code>\n🕐 Tin cũ: ${msgAge!=null?msgAge.toFixed(1)+"s":"?"}`,{parse_mode:"HTML"})}catch{}
          redeemAllSimultaneous(variants,msgAge);
        }catch(e){console.error("tele handler",e.message);}
      };
      teleClient.addEventHandler(handler,new NewMessage({}));
      teleHandlerAttached=true;
    }
    console.log(`✅ GramJS connected as ${teleAuthStatus.username?"@"+teleAuthStatus.username:teleAuthStatus.userId||"authorized user"}`);
    return true;
  }catch(e){console.error("Tele listener:",e.message);return false;}
}
let lastUpdateAt=0;
setInterval(async()=>{
  if(!TELETHON_API_ID||!redeemState.channel_id||!loadTeleSession())return;
  try{
    if(!teleClient||!teleClient.connected){
      console.warn("[WATCHDOG] Mất kết nối Telegram, đang kết nối lại…");
      await ensureTeleClient();
      await startTeleListener();
      console.log("[WATCHDOG] Đã kết nối lại");
    }
  }catch(e){console.error("[WATCHDOG]",e.message)}
},60000);
const server=http.createServer((req,res)=>{
  if(req.url==="/health"||req.url==="/healthz"){
    res.writeHead(200,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});
    res.end(JSON.stringify({status:"online",version:VERSION,enabled:!!redeemState.enabled,accounts:REDEEM_ACCOUNTS.length,telegram:teleAuthStatus.state,channel:redeemState.channel_name||null,channelJoined:redeemState.channel_joined??null,uptime:uptimeStr()}));return;
  }
  const statusColor=teleAuthStatus.state==="authorized"?"#28d69a":"#f0b45b";
  const html=`<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#0a1020"><title>LC79 · Control Center</title><style>
  :root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;padding:24px 16px;display:grid;place-items:center;background:radial-gradient(1000px 520px at 15% -10%,#17345a 0%,transparent 58%),radial-gradient(800px 460px at 100% 100%,#17274b 0%,transparent 56%),#080d19;color:#eef4ff;font:15px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif}.wrap{width:min(100%,560px)}.top{display:flex;align-items:center;gap:13px;margin-bottom:16px}.logo{width:48px;height:48px;border-radius:16px;display:grid;place-items:center;background:linear-gradient(145deg,#3e8cff,#7658ec);box-shadow:0 10px 30px #3b78ff44;font-size:23px}.eyebrow{font-size:11px;color:#8ea5c8;letter-spacing:.16em;font-weight:800}.title{font-size:22px;font-weight:850;letter-spacing:-.04em}.card{border:1px solid #273750;background:linear-gradient(150deg,#121e32ed,#101827f2);border-radius:24px;padding:23px;box-shadow:0 26px 80px #0007;backdrop-filter:blur(16px)}.status{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:13px 15px;border:1px solid #263a52;background:#0b1424;border-radius:15px;margin:15px 0 19px}.dot{display:inline-block;width:8px;height:8px;border-radius:99px;background:#28d69a;box-shadow:0 0 14px currentColor;margin-right:8px}.pill{font-size:11px;font-weight:800;letter-spacing:.08em;color:#b5c8e4}.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.metric{border:1px solid #263750;border-radius:16px;padding:14px;background:#111d30}.metric small{display:block;color:#92a6c4;font-size:12px}.metric strong{display:block;margin-top:4px;font-size:20px;letter-spacing:-.04em}.section{margin:22px 0 8px;color:#8fa7ca;font-size:11px;font-weight:850;letter-spacing:.13em}.line{display:flex;justify-content:space-between;gap:16px;padding:12px 0;border-bottom:1px solid #26344a}.line:last-child{border:0}.line span{color:#8fa4c3}.line b{text-align:right;overflow-wrap:anywhere}.hint{margin-top:19px;border-radius:14px;padding:13px 14px;background:#17263a;color:#a9bddb;font-size:12px}.foot{text-align:center;color:#637895;font-size:11px;margin:16px 0 0}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#c3d8f6;font-size:12px}@media(max-width:390px){.card{padding:18px}.grid{gap:8px}.metric{padding:12px}.title{font-size:19px}}
  </style></head><body><main class="wrap"><div class="top"><div class="logo">✨</div><div><div class="eyebrow">LC79 AUTOMATION</div><div class="title">Control Center</div></div></div><section class="card"><div style="font-size:13px;color:#9fb3d0">Hệ thống theo dõi mã & quản lý tài khoản</div><div class="status"><div><span class="dot" style="color:${statusColor};background:${statusColor}"></span><b>Service online</b></div><span class="pill">RUNNING</span></div><div class="grid"><div class="metric"><small>Tài khoản game</small><strong>${REDEEM_ACCOUNTS.length}</strong></div><div class="metric"><small>Auto redeem</small><strong style="font-size:15px;color:${redeemState.enabled?"#28d69a":"#f0b45b"}">${redeemState.enabled?"ĐANG BẬT":"ĐANG TẮT"}</strong></div><div class="metric"><small>Telegram session</small><strong style="font-size:14px;color:${statusColor}">${teleAuthStatus.state==="authorized"?"ĐÃ KẾT NỐI":"CHƯA XÁC THỰC"}</strong></div><div class="metric"><small>Thời gian chạy</small><strong style="font-size:17px">${uptimeStr()}</strong></div></div><div class="section">KÊNH NGUỒN</div><div class="line"><span>Kênh đã cấu hình</span><b>${esc(redeemState.channel_name||"Chưa đặt")}</b></div><div class="line"><span>Trạng thái thành viên</span><b>${esc(channelBadge())}</b></div><div class="section">PHIÊN HOẠT ĐỘNG</div><div class="line"><span>Code phát hiện</span><b>${stats.codesSeen}</b></div><div class="line"><span>Thành công / Thất bại</span><b>${stats.wins} / ${stats.fails}</b></div><div class="line"><span>Phiên bản</span><b class="mono">${VERSION}</b></div><div class="hint">Quản trị chi tiết bằng Telegram bot. Endpoint <span class="mono">/health</span> cung cấp trạng thái máy chủ dạng JSON.</div></section><div class="foot">SECURE TELEGRAM SESSION · LC79 CONTROL PANEL</div></main></body></html>`;
  res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store"});res.end(html);
});
server.listen(PORT,()=>console.log("HTTP:",PORT));if(KEEP_ALIVE_URL){setInterval(()=>{axios.get(KEEP_ALIVE_URL,{timeout:8000}).catch(()=>{})},10*60*1000)}setInterval(async()=>{for(const acc of REDEEM_ACCOUNTS){try{if(!acc.jwt||acc.jwtExp-Date.now()/1000<600)await acc.refreshToken()}catch{}}},240000);setInterval(()=>{if(redeemLogs.length>500){redeemLogs=redeemLogs.slice(-400);saveJson(REDEEM_LOGS_FILE,redeemLogs)}const keys=Object.keys(SEEN_ANNOUNCE);if(keys.length>200){for(const k of keys.slice(0,keys.length-100))delete SEEN_ANNOUNCE[k]}},15*60*1000);(async()=>{syncRedeemAccounts();for(const acc of REDEEM_ACCOUNTS){try{await acc.refreshToken()}catch{}await new Promise((r)=>setTimeout(r,400))}const listenerOk=await startTeleListener();if(!listenerOk)bot.sendMessage(ADMIN_ID,"⚠️ <b>Chưa bật được canh kênh</b>\n"+esc(teleAuthStatus.error||"Chưa có session Telegram hoặc thiếu API ID/HASH. Vào TELEGRAM / KÊNH để đăng nhập lại."),{parse_mode:"HTML"}).catch(()=>{});console.log("✨",VERSION,"— READY")})();