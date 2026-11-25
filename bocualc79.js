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
const { NewMessage, EditedMessage } = require("telegram/events");const BOT_TOKEN=(process.env.BOT_TOKEN||"").trim();const ADMIN_ID=parseInt(process.env.ADMIN_ID||"0",10);const TELETHON_API_ID=parseInt(process.env.TELETHON_API_ID||"0",10);const TELETHON_API_HASH=(process.env.TELETHON_API_HASH||"").trim();const TELE_SESSION_ENV=(process.env.TELE_SESSION||process.env.TELEGRAM_SESSION||process.env.SESSION_STRING||process.env.STRING_SESSION||"").trim();const DATA_DIR=path.resolve(process.env.DATA_DIR||".");const PORT=Number.parseInt(process.env.PORT||"10000",10)||10000;const KEEP_ALIVE_URL=(process.env.KEEP_ALIVE_URL||"").trim();const VERSION="bocualc79 v4.12 · Persistent Account Recovery";if(!fs.existsSync(DATA_DIR))fs.mkdirSync(DATA_DIR,{recursive:true});const REDEEM_STATE_FILE=path.join(DATA_DIR,"redeem_state.json");const REDEEM_LOGS_FILE=path.join(DATA_DIR,"redeem_logs.json");const GAME_ACCOUNTS_FILE=path.join(DATA_DIR,"game_accounts.json");const TELE_SESSION_FILE=path.join(DATA_DIR,"tele_session.txt");const DIV="────────────────────";const DIV2="━━━━━━━━━━━━━━━━━━━━";const MAX_RECENT_BOOTSTRAP_AGE_SEC=15*60;const MAX_REDEEM_QUEUE=50;const MAX_PARALLEL_ACCOUNTS=5;
// Mỗi mã có cửa sổ xử lý tối đa 4 phút kể từ lúc bot phát hiện bài TIN1.
// Retry có backoff, tôn trọng Retry-After và không lặp mã bị từ chối/credential sai.
const AUTO_REDEEM_WINDOW_MS=4*60*1000;
const RETRY_DELAYS_MS=[5000,10000,20000,30000];
const RETRY_MAX_DELAY_MS=30000;
const ACTIVITY_LIMIT=150;
const DEFAULT_CHANNEL={id:"2237214360",name:"Lẩu cua game - LC79 - Kênh tặng code",username:"codelaucuagame",link:"https://t.me/codelaucuagame"};
function nickFromSession(sk){try{if(!sk)return null;const s=String(sk)+"=".repeat((4-(String(sk).length%4))%4);return JSON.parse(Buffer.from(s,"base64").toString("utf8")).nickname||null}catch{return null}}
function md5(t){return crypto.createHash("md5").update(String(t)).digest("hex")}function normalizePw(pw){pw=String(pw||"").trim();if(pw.length===32&&/^[0-9a-f]+$/i.test(pw))return pw.toLowerCase();return md5(pw)}
function readJsonFile(file){try{return{exists:true,valid:true,data:JSON.parse(fs.readFileSync(file,"utf8"))}}catch(error){if(error?.code==="ENOENT")return{exists:false,valid:false,data:null,error};console.error("Load",file,error?.message||error);return{exists:true,valid:false,data:null,error}}}
function loadJson(file,fallback){const read=readJsonFile(file);return read.valid?read.data:fallback}
function saveJson(file,data){
  let fd=null;let temp="";
  try{
    const serialized=JSON.stringify(data,null,2);if(typeof serialized!=="string")throw new Error("Không thể tuần tự hoá JSON");
    fs.mkdirSync(path.dirname(file),{recursive:true});
    temp=`${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    fd=fs.openSync(temp,"wx",0o600);fs.writeFileSync(fd,serialized,"utf8");fs.fsyncSync(fd);fs.closeSync(fd);fd=null;
    fs.renameSync(temp,file);
    // Backup phản ánh state mới nhất đã commit; dữ liệu rỗng có chủ đích vẫn được backup.
    if(path.resolve(file)===path.resolve(REDEEM_STATE_FILE)){
      try{
        const backupTemp=`${file}.bak.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
        fs.copyFileSync(file,backupTemp);
        try{fs.chmodSync(backupTemp,0o600)}catch{}
        fs.renameSync(backupTemp,`${file}.bak`);
      }catch(backupError){console.error("[STATE] Không cập nhật được backup:",backupError?.message||backupError);}
    }
    // Đồng bộ entry thư mục để tăng độ bền sau khi tiến trình bị dừng đột ngột.
    if(path.resolve(file)===path.resolve(REDEEM_STATE_FILE)){
      try{const dirFd=fs.openSync(path.dirname(file),"r");fs.fsyncSync(dirFd);fs.closeSync(dirFd)}catch{}
    }
    return true;
  }catch(error){if(fd!==null){try{fs.closeSync(fd)}catch{}}if(temp){try{fs.unlinkSync(temp)}catch{}}console.error("Save",file,error?.message||error);return false;}
}
function validRedeemState(value){return !!value&&typeof value==="object"&&!Array.isArray(value)&&Array.isArray(value.accounts)}
function loadRedeemState(){
  const primary=readJsonFile(REDEEM_STATE_FILE);const backup=readJsonFile(`${REDEEM_STATE_FILE}.bak`);
  if(primary.valid&&validRedeemState(primary.data)){
    const current=primary.data;
    const expected=Number(current.account_count||0);
    const backupUsable=backup.valid&&validRedeemState(backup.data)&&backup.data.accounts.length>0;
    const looksTruncated=current.allow_empty_accounts!==true&&backupUsable&&(
      (current.accounts.length===0&&expected===0)||
      (expected>0&&current.accounts.length<expected&&backup.data.accounts.length>=expected)
    );
    if(looksTruncated){
      console.warn(`[STATE] State chính thiếu tài khoản (${current.accounts.length}/${expected||"?"}); khôi phục từ .bak`);
      return backup.data;
    }
    return current;
  }
  if(backup.valid&&validRedeemState(backup.data)){
    console.warn("[STATE] Không đọc được state chính; đã khôi phục từ .bak");
    return backup.data;
  }
  if(primary.exists)console.error("[STATE] State chính lỗi và không có backup hợp lệ; không tự ghi đè tệp gốc.");
  return{accounts:[],channel_id:null,channel_name:"",enabled:false,redeem_mode:"all",recent_codes:[],code_history:[]};
}
function esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}function money(n){return Number(n||0).toLocaleString("vi-VN")}function hashStr(s){let h=0;for(let i=0;i<s.length;i++)h=(h*31+s.charCodeAt(i))|0;return String(h)}
let redeemState=loadRedeemState();let allowAccountRemovalOnce=false;
function saveRedeemState(reason="update"){
  if(!redeemState||typeof redeemState!=="object"||!Array.isArray(redeemState.accounts)){console.error(`[STATE] Refuse invalid state save (${reason})`);return false;}
  const primary=readJsonFile(REDEEM_STATE_FILE);const backup=readJsonFile(`${REDEEM_STATE_FILE}.bak`);
  const primaryState=primary.valid&&validRedeemState(primary.data)?primary.data:null;
  const backupState=backup.valid&&validRedeemState(backup.data)?backup.data:null;
  let saved=primaryState||backupState;
  if(primaryState&&backupState&&primaryState.allow_empty_accounts!==true){
    const expected=Number(primaryState.account_count||0);
    const truncated=(primaryState.accounts.length===0&&expected===0)||(expected>0&&primaryState.accounts.length<expected&&backupState.accounts.length>=expected);
    if(truncated)saved=backupState;
  }
  if(saved&&!allowAccountRemovalOnce&&saved.accounts.length>redeemState.accounts.length){
    console.error(`[STATE] Refuse unexpected account shrink ${saved.accounts.length}->${redeemState.accounts.length} (${reason}); existing account data kept`);
    redeemState.accounts=saved.accounts;
    return false;
  }
  allowAccountRemovalOnce=false;
  if(redeemState.accounts.length>0)redeemState.allow_empty_accounts=false;
  if(redeemState.accounts.length===0&&saved?.accounts?.length&&!redeemState.allow_empty_accounts){
    console.error(`[STATE] Refuse empty account state (${reason}); restore existing accounts`);
    redeemState.accounts=saved.accounts;return false;
  }
  redeemState.state_version=3;redeemState.account_count=redeemState.accounts.length;redeemState.updated_at=new Date().toISOString();
  const ok=saveJson(REDEEM_STATE_FILE,redeemState);
  if(!ok)console.error(`[STATE] Failed to persist redeem_state.json (${reason})`);
  return ok;
}
function markInterruptedRedeems(){
  if(!Array.isArray(redeemState.code_history))return;
  let changed=false;
  for(const row of redeemState.code_history){
    if(row&&["QUEUED","RUNNING"].includes(String(row.status||""))){
      row.status="INTERRUPTED";row.interrupted_at=new Date().toISOString();
      row.interruption_note="Tiến trình dừng trước khi ghi trạng thái hoàn tất; kiểm tra kết quả từng tài khoản trước khi chạy lại để tránh redeem trùng.";
      changed=true;
      if(Array.isArray(redeemState.recent_codes))for(const recent of redeemState.recent_codes){if(String(recent?.code||"")===String(row.code||""))recent.status="INTERRUPTED";}
    }
  }
  if(changed)saveRedeemState("recover-interrupted-redeems");
}
function upsertCodeHistory(code,patch={}){
  if(!code)return null;
  if(!Array.isArray(redeemState.code_history))redeemState.code_history=[];
  let row=redeemState.code_history.find(x=>String(x?.code||"")===String(code));
  if(!row){row={code:String(code),created_at:new Date().toISOString()};redeemState.code_history.push(row);}
  Object.assign(row,patch,{updated_at:new Date().toISOString()});
  if(Array.isArray(redeemState.recent_codes))for(const recent of redeemState.recent_codes){if(String(recent?.code||"")===String(code)&&patch.status)recent.status=patch.status;}
  if(redeemState.code_history.length>300)redeemState.code_history=redeemState.code_history.slice(-300);
  saveRedeemState(`code-history:${code}`);return row;
}
let redeemLogs=loadJson(REDEEM_LOGS_FILE,[]);let gameAccounts=loadJson(GAME_ACCOUNTS_FILE,{});let REDEEM_ACCOUNTS=[];const ACTIVE_RUNS=new Set();const RECENT_CODES={};const SEEN_ANNOUNCE={};const userFlows={};let bootTime=Date.now();
let teleClient=null;
let teleLoginClient=null;
let teleLoginLock=false;
let teleHandlerAttached=false;
let teleHandlerClient=null;
const CHANNEL_POLL_MS=3000;
let channelPollTimer=null;
let channelPollBusy=false;
let channelMonitor={state:"starting",lastPollAt:null,lastUpdateAt:null,lastError:null,lastMessageId:0,lastCode:null};
const processingChannelMessages=new Set();
const redeemQueue=[];
const queuedCodes=new Set();
let redeemQueueRunning=false;
let activeRedeemRequests=0;
const redeemRequestWaiters=[];
async function withRedeemSemaphore(task,stop){
  if(activeRedeemRequests>=MAX_PARALLEL_ACCOUNTS){
    await new Promise(resolve=>redeemRequestWaiters.push(resolve));
  }else{
    activeRedeemRequests++;
  }
  try{
    if(stop?.stopped)return null;
    return await task();
  }finally{
    if(redeemRequestWaiters.length){
      const next=redeemRequestWaiters.shift();
      next(); // chuyển giao slot hiện có, không tăng activeRedeemRequests
    }else{
      activeRedeemRequests=Math.max(0,activeRedeemRequests-1);
    }
  }
}
const recentActivities=[];
let teleAuthStatus={state:"missing",username:null,userId:null,checkedAt:null,error:null};
const channelSearchCache=new Map();
let channelCacheValue=null;
let channelCacheId="";
let channelEntityCache=null;let channelEntityCacheClient=null;let stats={codesSeen:0,wins:0,fails:0,tin2Matches:0,tin2Stops:0,retryAttempts:0,lastCode:null,lastWinAt:null,lastDetectedAt:null};
// Recover counters from the persisted audit log so a Render restart does not erase history.
for(const row of redeemLogs){
  if(row?.type==="CODE_DETECTED"){stats.codesSeen++;stats.lastCode=row.code||stats.lastCode;}
  if(row?.type==="TIN2_ACCOUNT_MATCH")stats.tin2Matches++;
  if(row?.type==="REDEEM_STOP_TIN2")stats.tin2Stops++;
  if(row?.type==="REDEEM_RETRY_WAIT")stats.retryAttempts++;
  if(row?.type==="REDEEM"&&(row.status==="SUCCESS"||row.status==="SUCCESS_VERIFIED")){stats.wins++;stats.lastWinAt=row.time?Date.parse(row.time.replace(" ","T")+"Z"):stats.lastWinAt;}
  else if(row?.type==="REDEEM"){stats.fails++;}
}
function nowText(){return new Date().toISOString().replace("T"," ").slice(0,19)}
function persistLog(entry){redeemLogs.push(entry);if(redeemLogs.length>5000)redeemLogs=redeemLogs.slice(-5000);saveJson(REDEEM_LOGS_FILE,redeemLogs);return entry}
function addActivity(type,code="",account="",status="",detail=""){
  const row={time:nowText(),type,code:String(code||""),account:String(account||""),status:String(status||""),detail:String(detail||"").slice(0,500)};
  recentActivities.push(row);if(recentActivities.length>ACTIVITY_LIMIT)recentActivities.shift();
  persistLog(row);console.log(`[${type}] code=${row.code||"-"} account=${row.account||"-"} status=${row.status||"-"} ${row.detail}`);return row;
}
function appendRedeemLog(code,account,balBefore,balAfter,amount,status,detail=""){
  const row={time:nowText(),type:"REDEEM",code,account,balance_before:parseInt(balBefore||0,10),balance_after:parseInt(balAfter||0,10),amount:parseInt(amount||0,10),status,detail:String(detail||"").slice(0,500)};
  persistLog(row);console.log(`[REDEEM] ${code}|${account}|${status}|+${amount}${detail?` | ${detail}`:""}`);return row;
}
function maskAccount(value){const s=String(value||"");if(s.length<4)return s?"•••":"—";return s.slice(0,2)+"•••"+s.slice(-2)}function syncBalanceToStorage(username,newBalance){let u=false;for(const item of redeemState.accounts||[]){if(String(item.un||"").toLowerCase()===String(username).toLowerCase()){item.balance=parseInt(newBalance,10);u=true}}if(u)saveRedeemState(`balance:${username}`);for(const k of Object.keys(gameAccounts)){const info=gameAccounts[k];if(String(info.username||"").toLowerCase()===String(username).toLowerCase()){info.money=parseInt(newBalance,10);saveJson(GAME_ACCOUNTS_FILE,gameAccounts);break}}}class RedeemAccount{constructor(un,pw,nick,owner=null,balance=0){this.un=un;this.pw=pw;this.nick=nick;this.owner=owner;this.jwt=null;this.jwtExp=0;this.balance=parseInt(balance||0,10);this.addedAt=null;this.lastRefresh=null;this.wonCode=null;this.lastSummary="NO RESPONSE";this.lastRedeemStatus="NOT_STARTED";this.lastRedeemResult=null;this.API_GET_ACCESS="https://apifo88daigia.tele68.com/api";this.LOGIN_URL="https://wlb.tele68.com/v1/lobby/auth/login";this.BASE_URL="https://gameapi.tele68.com";this.PARAMS="/v1/giftcode/redemption?cp=R&cl=R&pf=web&at="}headers(auth){const h={"content-type":"application/json","user-agent":"Mozilla/5.0",origin:"https://play.lc79.bet",referer:"https://play.lc79.bet/",accept:"application/json,text/plain,*/*",connection:"keep-alive",};if(auth)h.authorization=`Bearer ${auth}`;return h}static parseJwtExp(token){try{const payload=token.split(".")[1];const pad="=".repeat((4-(payload.length%4))%4);return JSON.parse(Buffer.from(payload+pad,"base64url").toString("utf8")).exp||0}catch{return 0}}isTokenValid(){return!!(this.jwt&&Date.now()/1000<this.jwtExp-60)}async getAccessToken(){try{const res=await axios.get(this.API_GET_ACCESS,{params:{c:"3",un:this.un,pw:this.pw,cp:"R",cl:"R",pf:"web",at:""},headers:this.headers(),timeout:7000,});const data=res.data||{};if(!data.success){this.lastError='Đăng nhập game thất bại: '+(data.message||'sai tài khoản/mật khẩu hoặc API đã đổi');return null}if(!data.accessToken){this.lastError="API đăng nhập không trả accessToken";return null}this.lastError=null;this.sessionKey=data.sessionKey||null;return data.accessToken}catch(e){this.lastError='Lỗi mạng khi đăng nhập: '+e.message;console.error(`[${this.un}]access:`,e.message);return null}}async refreshToken(){
    if(this.refreshPromise)return this.refreshPromise;
    this.refreshPromise=(async()=>{
      const at=await this.getAccessToken();if(!at)return false;
      try{
        const res=await axios.post(this.LOGIN_URL,{nickName:nickFromSession(this.sessionKey)||this.nick,accessToken:at},{headers:{"content-type":"application/json",origin:"https://lc79b.bet",referer:"https://lc79b.bet/","user-agent":"Mozilla/5.0"},timeout:7000});
        const data=res.data||{};if(!data.token){this.lastError="Không nhận được token từ máy chủ";return false;}
        this.lastError=null;this.jwt=data.token;this.jwtExp=RedeemAccount.parseJwtExp(data.token)||(Date.now()/1000+300);this.lastRefresh=Date.now()/1000;
        const rawBal=data.remoteLoginResp&&data.remoteLoginResp.money;const newBal=rawBal==null?this.balance:parseInt(rawBal,10);
        if(Number.isFinite(newBal)){this.balance=newBal;syncBalanceToStorage(this.un,newBal);}return true;
      }catch(e){this.lastError="Lỗi refresh: "+(e?.response?.data?.message||e.message);console.error(`[${this.un}]refresh:`,this.lastError);return false;}
    })();
    try{return await this.refreshPromise;}finally{this.refreshPromise=null;}
  }
  async singleRedeem(code,stopEvent=null){
    try{
      const res=await axios.post(this.BASE_URL+this.PARAMS,{code:String(code).trim(),captcha:""},{headers:this.headers(this.jwt),timeout:9000,validateStatus:()=>true,signal:stopEvent?.controller?.signal});
      const data=res.data&&typeof res.data==="object"?res.data:{};
      const message=String(data.message||data.msg||data.detail||data.error_description||"").trim();
      const explicitFalse=data.success===false||data.success==="false"||data.status===false||data.status==="failed"||data.status==="error"||!!data.error;
      const amountRaw=data.money??data.amount??data.reward??data.data?.money??0;
      const amount=Number.parseInt(amountRaw,10)||0;
      const safeBody=JSON.stringify(data,(k,v)=>/token|authorization|password|session|secret|cookie/i.test(k)?"[REDACTED]":v).slice(0,420);
      if(res.status===401)return{status:"TOKEN_EXPIRED",message:message||"HTTP 401",httpStatus:401,amount:0};
      if(res.status===429)return{status:"RATE_LIMITED",message:message||"Máy chủ giới hạn tốc độ (HTTP 429)",httpStatus:429,retryAfter:res.headers?.["retry-after"]||null,amount:0};
      if(res.status>=500)return{status:"SERVER_ERROR",message:message||`HTTP ${res.status}`,body:safeBody,httpStatus:res.status,amount:0};
      if(res.status===200||res.status===201){
        if(explicitFalse||/thất bại|không hợp lệ|hết hạn|đã sử dụng|đã đổi|already|invalid|expired|not found|failed|error/i.test(message))return{status:"REJECTED",message:message||"Máy chủ từ chối mã",body:safeBody,httpStatus:res.status,amount:0};
        const explicitTrue=data.success===true||data.success==="true"||data.status==="success"||data.status==="ok"||amount>0||/thành công|success|redeemed|đổi thưởng thành công|nhận được/i.test(message);
        return{status:explicitTrue?"SUCCESS":"ACCEPTED_UNVERIFIED",message:message||"HTTP thành công nhưng chưa có tín hiệu xác nhận",body:safeBody,httpStatus:res.status,amount};
      }
      return{status:"HTTP_ERROR",message:message||`HTTP ${res.status}`,httpStatus:res.status,amount:0};
    }catch(e){
      const status=e?.response?.status||0;const message=e?.response?.data?.message||e.message||"Network error";
      if(status===429)return{status:"RATE_LIMITED",message:String(message),httpStatus:429,retryAfter:e?.response?.headers?.["retry-after"]||null,amount:0};
      return{status:"UNKNOWN_NETWORK",message:String(message),httpStatus:status||null,amount:0};
    }
  }
  async redeemOnce(code,stopEvent=null){
    const balBefore=this.balance;this.lastSummary="Đang chuẩn bị";
    addActivity("ACCOUNT_READY",code,this.un,"CHECK","Kiểm tra token và phiên đăng nhập");
    if(!this.isTokenValid()){
      addActivity("TOKEN_REFRESH",code,this.un,"RUNNING","Token hết hạn hoặc chưa có token; đang đăng nhập lại");
      if(!(await this.refreshToken())){
        this.lastRedeemStatus="LOGIN_FAIL";this.lastRedeemResult={status:"LOGIN_FAIL",message:this.lastError||"không lấy được token"};
        this.lastSummary="LOGIN_FAIL: "+(this.lastError||"không lấy được token");
        appendRedeemLog(code,this.un,balBefore,this.balance,0,"LOGIN_FAIL",this.lastSummary);
        addActivity("REDEEM_FAILED",code,this.un,"LOGIN_FAIL",this.lastSummary);return null;
      }
      addActivity("TOKEN_REFRESH",code,this.un,"OK","Đã lấy token mới");
    }
    if(stopEvent?.stopped){this.lastSummary="Đã dừng trước khi gửi request";return null;}
    addActivity("REQUEST_SENT",code,this.un,"SENDING","Gửi một request redeem duy nhất");
    let result=await this.singleRedeem(code,stopEvent);
    this.lastRedeemResult=result;this.lastRedeemStatus=result.status;
    // A 401 response means the server rejected the expired token; refresh once and retry once only.
    if(result.status==="TOKEN_EXPIRED"){
      addActivity("TOKEN_REFRESH",code,this.un,"RETRY_AUTH","API trả 401; refresh token rồi thử lại một lần");
      if(await this.refreshToken())result=await this.singleRedeem(code,stopEvent);
      else result={status:"LOGIN_FAIL",message:this.lastError||"Không refresh được token",amount:0};
      this.lastRedeemResult=result;this.lastRedeemStatus=result.status;
    }
    if(result.status==="SUCCESS"||result.status==="ACCEPTED_UNVERIFIED"){
      this.lastRedeemResult=result;this.lastRedeemStatus=result.status;
      const refreshOk=await this.refreshToken();
      const balAfter=this.balance;const delta=Math.max(0,balAfter-balBefore);
      const amount=Number(result.amount||0)||delta;
      if(result.status==="SUCCESS"||delta>0){
        this.lastSummary=`SUCCESS · +${money(amount)}`;this.wonCode=code;
        appendRedeemLog(code,this.un,balBefore,balAfter,amount,"SUCCESS",result.message);
        addActivity("REDEEM_SUCCESS",code,this.un,"SUCCESS",`${money(balBefore)} → ${money(balAfter)} · +${money(amount)}`);
        return{nick:this.nick,un:this.un,owner:this.owner,bal_before:balBefore,bal_after:balAfter,amount,code};
      }
      this.lastSummary=`CHƯA XÁC MINH · ${result.message||"không có thay đổi số dư"}${refreshOk?"":" · refresh balance lỗi"} · body=${result.body||"—"}`;
      appendRedeemLog(code,this.un,balBefore,balAfter,0,"UNVERIFIED",this.lastSummary);
      addActivity("REDEEM_UNVERIFIED",code,this.un,"UNVERIFIED",this.lastSummary);return null;
    }
    if(result.status==="UNKNOWN_NETWORK"){
      this.lastRedeemResult=result;this.lastRedeemStatus=result.status;
      // Network timeout is ambiguous: refresh balance for verification; never blindly resend.
      const refreshOk=await this.refreshToken();const balAfter=this.balance;const delta=Math.max(0,balAfter-balBefore);
      if(refreshOk&&delta>0){
        this.lastSummary=`SUCCESS_VERIFIED_AFTER_TIMEOUT · +${money(delta)}`;this.wonCode=code;
        appendRedeemLog(code,this.un,balBefore,balAfter,delta,"SUCCESS_VERIFIED",result.message);
        addActivity("REDEEM_SUCCESS",code,this.un,"VERIFIED",`Timeout nhưng số dư tăng ${money(delta)}`);
        return{nick:this.nick,un:this.un,owner:this.owner,bal_before:balBefore,bal_after:balAfter,amount:delta,code};
      }
      this.lastSummary=`UNKNOWN · ${result.message} · không tự gửi lại để tránh redeem trùng`;
     }else{
      this.lastRedeemResult=result;this.lastRedeemStatus=result.status;
      this.lastSummary=`${result.status} · ${result.message||"Không có thông tin phản hồi"} · HTTP ${result.httpStatus||"?"}${result.retryAfter?` · Retry-After ${result.retryAfter}`:""} · body=${result.body||"—"}`;
    }
    appendRedeemLog(code,this.un,balBefore,this.balance,0,result.status,this.lastSummary);
    addActivity("REDEEM_FAILED",code,this.un,result.status,this.lastSummary);
    return null;
  }}function summarizeResults(results){const counts={};for(const[st]of results)counts[st]=(counts[st]||0)+1;if(!Object.keys(counts).length)return "NO RESPONSE";return Object.entries(counts).sort((a,b)=>b[1]-a[1]).map(([st,n])=>`${st}×${n}`).join(" · ")}function normalizeRedeemCode(value){
  let code=String(value||"").normalize("NFKC").toUpperCase().replace(/[\u200b-\u200f\ufeff\s:_-]/g,"");
  // LC79 is a source prefix, not part of the redeem code.
  if(code.startsWith("LC79"))code=code.slice(4);
  return code.replace(/[^A-Z0-9]/g,"");
}
function codeVariants(rawText){
  if(!rawText)return[];
  const text=String(rawText).normalize("NFKC").replace(/[\u200b-\u200f\ufeff]/g,"").replace(/\r/g,"\n");
  const patterns=[
    /(?:MÃ\s*CODE|MÃ\s*QUÀ\s*TẶNG|GIFT\s*CODE|GIFTCODE)\s*(?:LÀ)?\s*[:：=–-]?\s*(?:LC79[\s:_-]*)?([A-Z0-9]{4,32})\b/iu,
    /(?:CODE|MÃ)\s*[:：=–-]\s*(?:LC79[\s:_-]*)?([A-Z0-9]{4,32})\b/iu,
    /\bLC79[\s:_-]+([A-Z0-9]{4,32})\b/iu,
    /\bLC79([A-Z0-9]{4,32})\b/iu,
  ];
  for(const re of patterns){
    const m=text.match(re);if(!m)continue;
    const value=normalizeRedeemCode(m[1]);
    if(value.length>=4&&value!=="LC79")return[value];
  }
  return[];
}
function isCodeAnnouncement(text){
  const raw=String(text||"");
  return /code\s*tương\s*tác\s*cổng\s*game\s*LC79|mã\s*code\s*(?:là)?\s*[:：=]?|mã\s*quà\s*tặng|gift\s*code|giftcode/i.test(raw)&&codeVariants(raw).length>0;
}
function isSuccessAnnouncement(text){
  const raw=String(text||"");
  return ANNOUNCE_RE.test(raw)||ANNOUNCE_STOP_RE.test(raw);
}
function buildRedeemAccounts(){const result=[];for(const item of redeemState.accounts||[]){if(!item||typeof item!=="object")continue;const un=String(item.un||item.username||"").trim();const pw=String(item.pw||item.password||"").trim();const nick=String(item.nick||item.nickname||un).trim();if(un&&pw){const acc=new RedeemAccount(un,pw,nick||un,item.owner,item.balance||0);acc.addedAt=item.added_at||null;result.push(acc)}}return result}
function reconcileRedeemAccounts(){
  const previous=new Map((REDEEM_ACCOUNTS||[]).map(acc=>[String(acc.un||"").toLowerCase(),acc]));
  const next=[];const seen=new Set();
  for(const item of redeemState.accounts||[]){
    if(!item||typeof item!=="object")continue;
    const un=String(item.un||item.username||"").trim();const pw=String(item.pw||item.password||"").trim();
    if(!un||!pw||seen.has(un.toLowerCase()))continue;seen.add(un.toLowerCase());
    const nick=String(item.nick||item.nickname||un).trim();let account=previous.get(un.toLowerCase());
    if(account){
      if(account.pw!==pw){account.jwt=null;account.jwtExp=0;account.sessionKey=null;account.lastRefresh=null;}
      account.un=un;account.pw=pw;account.nick=nick||un;account.owner=item.owner??account.owner;
      account.balance=Number.parseInt(item.balance??account.balance??0,10)||0;
      account.addedAt=item.added_at||account.addedAt||null;
    }else{
      account=new RedeemAccount(un,pw,nick||un,item.owner,item.balance||0);account.addedAt=item.added_at||null;
    }
    const persistedAt=Date.parse(item.last_redeem_at||"")||0;
    const runtimeAt=Number(account.lastRedeemAt||0);
    if(!runtimeAt||persistedAt>=runtimeAt){
      account.lastRedeemStatus=String(item.last_redeem_status||account.lastRedeemStatus||"NOT_STARTED");
      account.lastSummary=String(item.last_redeem_summary||account.lastSummary||"NO RESPONSE");
      account.wonCode=item.last_success_code||item.won_code||account.wonCode||null;
      account.lastRedeemCode=item.last_redeem_code||account.lastRedeemCode||null;
      account.lastRedeemAmountText=item.last_redeem_amount_text||account.lastRedeemAmountText||"";
      account.lastRedeemAt=persistedAt||runtimeAt;
    }
    next.push(account);
  }
  REDEEM_ACCOUNTS.splice(0,REDEEM_ACCOUNTS.length,...next);
  return REDEEM_ACCOUNTS;
}
function persistAccountRedeemResult(account,code,result={}){
  const username=String(account?.un||"").toLowerCase();
  const item=(redeemState.accounts||[]).find(row=>String(row?.un||row?.username||"").toLowerCase()===username);
  if(!item)return false;
  const at=new Date().toISOString();
  item.last_redeem_status=String(account.lastRedeemStatus||result.status||"UNKNOWN");
  item.last_redeem_summary=String(account.lastSummary||result.detail||"").slice(0,360);
  item.last_redeem_code=String(code||account.lastRedeemCode||"");
  item.last_redeem_amount_text=String(result.amountText??result.win?.amount??account.lastRedeemAmountText??"");
  item.last_redeem_at=at;
  account.lastRedeemCode=item.last_redeem_code;
  account.lastRedeemAmountText=item.last_redeem_amount_text;
  account.lastRedeemAt=Date.parse(at);
  if(result.win||result.status==="TIN2_CONFIRMED"){
    item.last_success_code=String(code||"");
    if(result.win)item.last_success_amount=Number(result.win.amount||0);
    if(result.amountText)item.last_success_amount_text=String(result.amountText);
    item.last_success_at=at;
    item.won_code=String(code||"");
    account.wonCode=String(code||"");
  }
  return saveRedeemState(`account-redeem:${account.un}`);
}
function syncRedeemAccounts(){
  const read=readJsonFile(REDEEM_STATE_FILE);
  if(read.valid&&read.data&&typeof read.data==="object"&&!Array.isArray(read.data)){
    let disk=read.data;const memory=redeemState||{};let changed=false;
    const backupRead=readJsonFile(`${REDEEM_STATE_FILE}.bak`);
    const backupState=backupRead.valid&&validRedeemState(backupRead.data)?backupRead.data:null;
    const memoryAccounts=Array.isArray(memory.accounts)?memory.accounts:[];
    const diskAccountCount=Array.isArray(disk.accounts)?disk.accounts.length:0;
    const expectedCount=Number(disk.account_count||0);
    const diskLooksTruncated=disk.allow_empty_accounts!==true&&backupState?.accounts?.length&&(
      (diskAccountCount===0&&expectedCount===0)||
      (expectedCount>0&&diskAccountCount<expectedCount&&backupState.accounts.length>=expectedCount)
    );
    if(diskLooksTruncated){
      disk={...backupState};changed=true;console.warn(`[STATE] State chính thiếu tài khoản (${disk.accounts.length}/${expectedCount||"?"}); khôi phục ${backupState.accounts.length} tài khoản từ backup.`);
    }
    if(!Array.isArray(disk.accounts)){disk.accounts=memoryAccounts;changed=true;}
    else if(disk.accounts.length<memoryAccounts.length&&!disk.allow_empty_accounts){disk.accounts=memoryAccounts;changed=true;console.warn(`[STATE] Disk có ít tài khoản hơn bộ nhớ (${diskAccountCount}->${memoryAccounts.length}); giữ danh sách đầy đủ trong bộ nhớ.`);}
    const preserveKeys=["channel_id","channel_name","channel_username","channel_link","channel_joined","channel_join_pending","channel_cursor_channel_id","channel_last_message_id","redeem_mode","active_account","last_detected_code","last_detected_code_at"];
    for(const key of preserveKeys){
      const missing=disk[key]===undefined||disk[key]===null||disk[key]==="";
      const keepPending=key==="channel_id"&&disk.channel_join_pending===true;
      if(missing&&!keepPending&&memory[key]!==undefined&&memory[key]!==null&&memory[key]!==""){disk[key]=memory[key];changed=true;}
    }
    if(!Array.isArray(disk.recent_codes)){disk.recent_codes=Array.isArray(memory.recent_codes)?memory.recent_codes:[];changed=true;}
    else if(Array.isArray(memory.recent_codes)&&memory.recent_codes.length>disk.recent_codes.length){
      const merged=new Map();for(const row of [...disk.recent_codes,...memory.recent_codes])if(row?.code)merged.set(String(row.code),row);
      disk.recent_codes=[...merged.values()].slice(-200);changed=true;
    }
    if(!Array.isArray(disk.code_history)){disk.code_history=Array.isArray(memory.code_history)?memory.code_history:[];changed=true;}
    if(disk.redeem_mode!=="single"&&disk.redeem_mode!=="all")disk.redeem_mode=memory.redeem_mode==="single"?"single":"all";
    disk.enabled=!!disk.enabled;
    if(!disk.channel_id&&!disk.channel_join_pending){disk.channel_id=DEFAULT_CHANNEL.id;disk.channel_name=DEFAULT_CHANNEL.name;disk.channel_username=DEFAULT_CHANNEL.username;disk.channel_link=DEFAULT_CHANNEL.link;disk.channel_joined=true;disk.channel_join_pending=false;changed=true;}
    if(disk.enabled&&(disk.channel_joined!==true||disk.channel_join_pending)){disk.enabled=false;disk.enabled_safety_reset_at=new Date().toISOString();changed=true;console.warn("[SAFETY] Auto Redeem đã tắt: cần xác minh lại trạng thái thành viên Telegram.");}
    redeemState=disk;
    if(changed)saveRedeemState("sync-recover");
  }else if(read.exists){
    console.error("[STATE] Tệp state không hợp lệ; giữ dữ liệu trong bộ nhớ/backup, không thay bằng danh sách rỗng.");
  }
  reconcileRedeemAccounts();
  if(!redeemState.active_account&&REDEEM_ACCOUNTS.length){redeemState.active_account=REDEEM_ACCOUNTS[0].un;saveRedeemState("set-default-account");}
  if(redeemState.active_account&&!REDEEM_ACCOUNTS.some(a=>a.un.toLowerCase()===String(redeemState.active_account).toLowerCase())){redeemState.active_account=REDEEM_ACCOUNTS[0]?.un||"";saveRedeemState("repair-active-account");}
  return REDEEM_ACCOUNTS;
}
const ANNOUNCE_RE=/Chúc\s*mừng\s+([^\s,!:()]+)(?:\s*\([^)]*\))?\s+đã\s+(?:đổi\s+thành\s+công|nhận(?:\s+được)?(?:\s+thành\s+công)?|lụm(?:\s+code)?)\b[\s\S]*?(?:trị\s*giá|giá\s*trị)\s*[:：]?\s*([\d.,]+)/iu;
const ANNOUNCE_STOP_RE=/đã\s+(?:đổi\s+thành\s+công|nhận(?:\s+được)?|lụm(?:\s+code)?)\b/i;
function normalizeLoginName(value){return String(value||"").trim().replace(/^@/,"").toLocaleLowerCase("vi-VN");}
function parseSuccessAnnouncement(text){
  const raw=String(text||"");
  const m=raw.match(ANNOUNCE_RE);
  if(!m&&!ANNOUNCE_STOP_RE.test(raw))return null;
  return {username:m?String(m[1]||"").trim().replace(/^@/,""):"",amount:m?String(m[2]||"").trim():""};
}
function stopActiveRedeemRunForTin2(code,claimedName){
  if(!code)return false;
  let stopped=false;
  const who=String(claimedName||"người nhận chưa rõ").trim();
  for(const run of ACTIVE_RUNS){
    if(run.codes?.includes(code)){
      run.tin2MatchedUser=who;
      run.tin2MatchedAt=Date.now();
      if(!run.stop.stopped){
        run.stop.stopped=true;
        run.stop.reason=`TIN2: kênh xác nhận ${who} đã nhận code`;
        try{run.stop.controller?.abort();}catch{}
        addActivity("REDEEM_STOP_TIN2",code,who,"STOPPED","TIN2 xác nhận đã có người nhận code; dừng retry và toàn bộ lượt đang chờ, bất kể username thuộc tài khoản mình hay người ngoài");
        stats.tin2Stops++;
        stopped=true;
      }
    }
  }
  return stopped;
}
async function handleAnnouncement(text,messageId=0){
  const raw=String(text||"");
  const parsed=parseSuccessAnnouncement(raw);
  if(!parsed)return false;
  const {username:claimedName,amount}=parsed;
  const now=Date.now()/1000;
  const channelKey=normalizeChannelId(redeemState.channel_id||"")||"channel";
  const key=messageId?`msg:${channelKey}:${messageId}`:`body:${hashStr(raw)}`;
  if(SEEN_ANNOUNCE[key]&&now-SEEN_ANNOUNCE[key]<24*3600)return true;
  SEEN_ANNOUNCE[key]=now;
  syncRedeemAccounts();
  const claimedLow=normalizeLoginName(claimedName);
  const matched=claimedLow?REDEEM_ACCOUNTS.filter(acc=>normalizeLoginName(acc.un)===claimedLow):[];
  const activeRun=[...ACTIVE_RUNS].filter(run=>now-(run.started||0)<1800).sort((x,y)=>(y.started||0)-(x.started||0))[0];
  const latestCodeAge=Number(redeemState.last_detected_code_at||0)?now-Number(redeemState.last_detected_code_at):Infinity;
  const associatedCode=activeRun?.codes?.[0]||(latestCodeAge<=1800?String(redeemState.last_detected_code||""):"");
  const codeLabel=associatedCode?`\n🎁 Mã đang đối chiếu: <code>${esc(associatedCode)}</code>`:"";
  const amountLabel=amount?`\n💰 Trị giá: <b>${esc(amount)}</b>`:"";
  // TIN2 là tín hiệu code đã được một người nhận thành công. Dừng mã đang chạy
  // kể cả khi username là người ngoài; đối chiếu username vẫn được báo riêng bên dưới.
  const stoppedRun=associatedCode?stopActiveRedeemRunForTin2(associatedCode,claimedName||"người nhận chưa rõ"):false;
  if(associatedCode){
    const prior=redeemState.code_history?.find(row=>String(row.code||"")===associatedCode);
    upsertCodeHistory(associatedCode,{status:"STOPPED_TIN2",tin2:{username:claimedName||"",amount:amount||"",message_id:messageId||null,received_at:new Date().toISOString(),matched_account:false},tin2_stop_reason:claimedName?`Kênh xác nhận ${claimedName} đã nhận code`:"Kênh báo có người nhận code",prior_status:prior?.status||null});
  }
  if(!claimedName){
    addActivity("TIN2_ANNOUNCEMENT","","","NOTICE","Kênh có thông báo đổi/nhận thành công nhưng không tách được tên đăng nhập");
    await bot.sendMessage(ADMIN_ID,`📢 <b>TIN2 · KÊNH BÁO CÓ NGƯỜI NHẬN CODE</b>\n${DIV}\nKhông tách được tên đăng nhập để đối chiếu.${amountLabel}${codeLabel}\n${stoppedRun?"🛑 Đã dừng auto retry cho mã này.":"ℹ️ Không có lượt redeem tương ứng đang chạy."}\n⚠️ Không tự ghi nhận tài khoản nào là thắng.`,{parse_mode:"HTML"}).catch(()=>{});
    return true;
  }
  if(!matched.length){
    addActivity("TIN2_EXTERNAL_WIN",associatedCode,claimedName,"NO_MATCH",`Kênh báo ${claimedName} đã đổi thành công${amount?` · ${amount}`:""}; không trùng tên đăng nhập đã lưu`);
    await bot.sendMessage(ADMIN_ID,`📢 <b>TIN2 · CÓ NGƯỜI ĐỔI CODE THÀNH CÔNG</b>\n${DIV}\n👤 Tên kênh báo: <code>${esc(claimedName)}</code>${amountLabel}${codeLabel}\n${stoppedRun?"🛑 Đã dừng mọi lần retry của mã này.":"ℹ️ Không có lượt redeem tương ứng đang chạy."}\n⚠️ <b>Không trùng</b> với tên đăng nhập của tài khoản đã lưu.`,{parse_mode:"HTML"}).catch(()=>{});
    return true;
  }
  if(associatedCode){
    const history=redeemState.code_history?.find(row=>String(row.code||"")===associatedCode);
    if(history?.tin2)history.tin2.matched_account=true;
    saveRedeemState(`tin2-match:${associatedCode}`);
  }
  const matchedLines=[];
  for(const acc of matched){
    const alreadyConfirmed=!!(associatedCode&&acc.wonCode===associatedCode);
    if(associatedCode)acc.wonCode=associatedCode;
    acc.lastRedeemStatus="TIN2_CONFIRMED";
    acc.lastSummary=`TIN2 CONFIRMED · ${amount||"đã nhận thành công"}`;
    if(associatedCode)acc.wonCode=associatedCode;
    persistAccountRedeemResult(acc,associatedCode,{status:"TIN2_CONFIRMED",detail:acc.lastSummary,amountText:amount||""});
    addActivity("TIN2_ACCOUNT_MATCH",associatedCode,acc.un,alreadyConfirmed?"CONFIRMED_AGAIN":"MATCHED",`Tên đăng nhập trùng tên kênh thông báo ${claimedName}${amount?` · trị giá ${amount}`:""}`);
    stats.tin2Matches++;
    matchedLines.push(`✅ <code>${esc(acc.un)}</code>${alreadyConfirmed?" · API cũng đã báo thành công":" · TIN2 xác nhận"}`);
    void acc.refreshToken().catch(()=>{});
    if(acc.owner&&acc.owner!==ADMIN_ID){
      bot.sendMessage(acc.owner,`🎉 <b>TIN2 XÁC NHẬN TÀI KHOẢN ĐÃ ĐỔI CODE</b>\n${DIV}\n👤 <code>${esc(acc.un)}</code>${codeLabel}${amountLabel}`,{parse_mode:"HTML"}).catch(()=>{});
    }
  }
  await bot.sendMessage(ADMIN_ID,`✅ <b>TIN2 · KHỚP TÀI KHOẢN CỦA BẠN</b>\n${DIV}\n👤 Tên đăng nhập: <code>${esc(claimedName)}</code>${codeLabel}${amountLabel}\n${matchedLines.join("\n")}\n\n📌 Đã ghi nhật ký đối chiếu TIN2.`,{parse_mode:"HTML"}).catch(()=>{});
  return true;
}
function selectedRedeemAccount(){
  const selected=String(redeemState.active_account||"").toLowerCase();
  return REDEEM_ACCOUNTS.find(a=>a.un.toLowerCase()===selected)||REDEEM_ACCOUNTS[0]||null;
}
async function sendRedeemBatchSummary(code,results,elapsed,msgAge,mode){
  const successes=results.filter(x=>x.win).length;
  const failed=results.filter(x=>!x.win&&!x.skipped).length;
  const skipped=results.filter(x=>x.skipped).length;
  const lines=results.map(x=>{
    const acc=x.account;
    if(x.win)return `✅ <code>${esc(acc.un)}</code> · +<b>${money(x.win.amount)}</b> · ${money(x.win.bal_before)} → ${money(x.win.bal_after)}`;
    if(x.skipped)return `⏭ <code>${esc(acc.un)}</code> · ${esc(x.detail||"Đã dừng trước khi gửi")}`;
    return `❌ <code>${esc(acc.un)}</code> · ${esc(acc.lastSummary||x.detail||"Không thành công")}`;
  });
  const msg=`<b>📋 KẾT QUẢ REDEEM ĐỒNG LOẠT</b>\n${DIV2}\n`+
    `🎁 Mã: <code>${esc(code)}</code>\n`+
    `👥 Chế độ: <b>${mode==="all"?"TẤT CẢ TÀI KHOẢN":"MỘT TÀI KHOẢN"}</b> · ${results.length} acc\n`+
    `🕒 Tuổi bài: ${msgAge!=null?msgAge.toFixed(1)+" giây":"không rõ"} · Tổng thời gian: ${elapsed.toFixed(2)} giây\n`+
    `✅ Thành công API: <b>${successes}</b> · ❌ Chưa thành công: <b>${failed}</b> · ⏭ Bỏ qua: <b>${skipped}</b>\n${DIV}\n`+
    (lines.join("\n")||"Không có tài khoản được xử lý.")+
    `\n${DIV}\n<i>Retry có giới hạn trong cửa sổ 4 phút, có backoff và tuân thủ Retry-After; dừng khi kênh phát TIN2. Lỗi từ chối mã/token không được gửi lặp.</i>`;
  await bot.sendMessage(ADMIN_ID,msg,{parse_mode:"HTML"}).catch(e=>console.warn("[BOT] summary:",e.message));
  for(const item of results){
    if(item.win&&item.account?.owner&&item.account.owner!==ADMIN_ID){
      bot.sendMessage(item.account.owner,`🎉 <b>CODE ĐÃ ĐỔI THÀNH CÔNG</b>\n${DIV}\nMã: <code>${esc(code)}</code>\nTài khoản: <code>${esc(item.account.un)}</code>\nSố dư: ${money(item.win.bal_before)} → <b>${money(item.win.bal_after)}</b> (+${money(item.win.amount)})`,{parse_mode:"HTML"}).catch(()=>{});
    }
  }
}
function retryDelayFor(result,attempt,remainingMs=Infinity){
  if(!result)return null;
  if(result.status==="RATE_LIMITED"){
    const raw=String(result.retryAfter||"").trim();
    let seconds=Number(raw);
    if(!Number.isFinite(seconds)||seconds<=0){
      const date=Date.parse(raw);
      seconds=Number.isFinite(date)?Math.ceil((date-Date.now())/1000):15;
    }
    // Không retry trước thời điểm máy chủ cho phép. Retry-After dài hơn cửa sổ 4 phút
    // đồng nghĩa dừng vì hết hạn, không tự ý bỏ qua giới hạn của server.
    const waitMs=Math.max(1000,seconds*1000);
    return waitMs<=remainingMs?waitMs:null;
  }
  const transient=(result.status==="SERVER_ERROR"||result.status==="UNKNOWN_NETWORK"||
    (result.status==="HTTP_ERROR"&&[408,425,500,502,503,504].includes(Number(result.httpStatus))));
  if(!transient)return null;
  const base=RETRY_DELAYS_MS[Math.min(Math.max(0,attempt-1),RETRY_DELAYS_MS.length-1)]||RETRY_MAX_DELAY_MS;
  const jitter=Math.floor(Math.random()*1000);
  const waitMs=Math.min(RETRY_MAX_DELAY_MS,base+jitter);
  return waitMs<=remainingMs?waitMs:null;
}
function waitUntilStoppedOrDeadline(ms,stop,deadlineAt){
  return new Promise(resolve=>{
    let done=false;
    const finish=value=>{if(done)return;done=true;clearTimeout(timer);clearInterval(poll);resolve(value);};
    const remaining=Math.max(0,deadlineAt-Date.now());
    const wait=Math.min(Math.max(0,ms),remaining);
    const timer=setTimeout(()=>finish(Date.now()>=deadlineAt?"deadline":(stop?.stopped?"stopped":"elapsed")),wait);
    const poll=setInterval(()=>{
      if(stop?.stopped)finish("stopped");
      else if(Date.now()>=deadlineAt)finish("deadline");
    },200);
    if(stop?.stopped)finish("stopped");
    else if(Date.now()>=deadlineAt)finish("deadline");
  });
}
function isTemporaryAuthError(message){
  return /timeout|timed out|network|socket|econn|etimedout|eai_again|enotfound|temporar|502|503|504|429/i.test(String(message||""));
}
async function makePendingAfterBalanceChange(account,code,before,source){
  const after=Number(account.balance||0);const delta=Math.max(0,after-Number(before||0));
  if(delta<=0)return null;
  account.lastRedeemStatus="PENDING_TIN2";
  account.lastSummary=`Số dư tăng ${money(delta)} sau ${source}; dừng gửi lại tài khoản này và chờ TIN2 xác nhận`;
  appendRedeemLog(code,account.un,before,after,delta,"PENDING_TIN2",account.lastSummary);
  addActivity("REDEEM_PENDING_TIN2",code,account.un,"WAITING",account.lastSummary);
  return {account,win:null,skipped:false,pending:true,detail:account.lastSummary};
}
async function redeemAccountWithRetries(account,code,stop,run){
  const deadlineAt=Number(run?.deadlineAt||((run?.started||Date.now()/1000)*1000+AUTO_REDEEM_WINDOW_MS));
  let attempt=0;let retryIndex=0;let verificationRequired=false;let verifyBalanceBefore=Number(account.balance||0);
  while(Date.now()<deadlineAt){
    if(stop.stopped)return{account,win:null,skipped:true,detail:stop.reason||"TIN2 đã xác nhận; dừng retry"};

    // Sau timeout/5xx/200 chưa rõ, bắt buộc xác minh phiên và số dư trước khi gửi lại.
    // Nếu kiểm tra chưa được thì chỉ retry bước xác minh, tuyệt đối chưa gửi redeem.
    if(verificationRequired){
      addActivity("REDEEM_VERIFY_RETRY",code,account.un,"CHECK","Đang kiểm tra lại token/số dư sau phản hồi không rõ kết quả");
      const refreshed=await account.refreshToken().catch(()=>false);
      if(refreshed){
        const pending=await makePendingAfterBalanceChange(account,code,verifyBalanceBefore,"request trước");
        if(pending)return pending;
        verificationRequired=false;
      }else{
        const remaining=deadlineAt-Date.now();
        const delay=Math.min(15000,remaining);
        if(delay<=0)break;
        addActivity("REDEEM_VERIFY_WAIT",code,account.un,"WAIT",`Chưa xác minh được số dư; thử xác minh lại sau ${Math.ceil(delay/1000)}s, không gửi redeem mới`);
        const waited=await waitUntilStoppedOrDeadline(delay,stop,deadlineAt);
        if(waited==="stopped")return{account,win:null,skipped:true,detail:stop.reason||"TIN2 đã xác nhận"};
        continue;
      }
    }

    // Tài khoản cần token hợp lệ trước mỗi lượt. Lỗi mạng khi refresh sẽ được thử lại
    // trong cửa sổ thời gian; sai thông tin đăng nhập là lỗi cố định và không spam login.
    if(!account.isTokenValid()){
      addActivity("TOKEN_REFRESH",code,account.un,"RUNNING","Token chưa hợp lệ; làm mới trước khi gửi request");
      const refreshed=await account.refreshToken().catch(()=>false);
      if(!refreshed){
        const err=account.lastError||"Không refresh được token";
        if(!isTemporaryAuthError(err)){
          account.lastRedeemStatus="LOGIN_FAIL";account.lastSummary=`LOGIN_FAIL · ${err}`;
          addActivity("REDEEM_RETRY_STOP",code,account.un,"AUTH_FAILED",account.lastSummary);
          return{account,win:null,skipped:false,detail:account.lastSummary};
        }
        const remaining=deadlineAt-Date.now();const delay=Math.min(15000,remaining);
        if(delay<=0)break;
        stats.retryAttempts++;
        addActivity("TOKEN_REFRESH_WAIT",code,account.un,"WAIT",`Lỗi mạng khi refresh token; thử lại sau ${Math.ceil(delay/1000)}s`);
        const waited=await waitUntilStoppedOrDeadline(delay,stop,deadlineAt);
        if(waited==="stopped")return{account,win:null,skipped:true,detail:stop.reason||"TIN2 đã xác nhận"};
        continue;
      }
    }

    if(stop.stopped)return{account,win:null,skipped:true,detail:stop.reason||"TIN2 đã xác nhận"};
    const balanceBeforeAttempt=Number(account.balance||0);
    attempt++;
    account.lastSummary=`Lượt ${attempt} · cửa sổ tối đa 4 phút`;
    addActivity("REDEEM_ATTEMPT",code,account.un,"RUNNING",`Lượt gửi ${attempt}; còn ${Math.max(0,Math.ceil((deadlineAt-Date.now())/1000))}s trong cửa sổ 4 phút`);
    let win=null;
    try{win=await withRedeemSemaphore(()=>account.redeemOnce(code,stop),stop);}catch(error){
      account.lastRedeemStatus="LOCAL_EXCEPTION";
      account.lastRedeemResult={status:"LOCAL_EXCEPTION",message:String(error?.message||error)};
      account.lastSummary=`LOCAL_EXCEPTION · ${error?.message||error}`;
      addActivity("REDEEM_EXCEPTION",code,account.un,"ERROR",account.lastSummary);
    }
    if(win)return{account,win,skipped:false};
    if(stop.stopped)return{account,win:null,skipped:true,detail:stop.reason||"Đã dừng theo TIN2"};

    const result=account.lastRedeemResult||{status:account.lastRedeemStatus||"UNKNOWN"};
    // Hết hạn/từ chối rõ ràng không thể giải quyết bằng retry. Không tiếp tục tạo tải vô ích.
    if(result.status==="REJECTED"){
      addActivity("REDEEM_RETRY_STOP",code,account.un,"CODE_REJECTED","Máy chủ từ chối mã (sai/hết hạn/đã sử dụng); không gửi lặp");
      return{account,win:null,skipped:false,detail:account.lastSummary||result.message||"Mã bị từ chối"};
    }
    if(result.status==="LOGIN_FAIL"){
      const err=account.lastError||result.message||"Đăng nhập thất bại";
      if(!isTemporaryAuthError(err)){
        addActivity("REDEEM_RETRY_STOP",code,account.un,"AUTH_FAILED",`Thông tin đăng nhập/token không hợp lệ: ${err}`);
        return{account,win:null,skipped:false,detail:account.lastSummary||err};
      }
      // lỗi mạng lúc login: vòng sau sẽ refresh token trước, chưa gửi request redeem.
      const remaining=deadlineAt-Date.now();const delay=Math.min(15000,remaining);
      if(delay<=0)break;
      stats.retryAttempts++;
      addActivity("REDEEM_RETRY_WAIT",code,account.un,"WAIT",`Lỗi mạng xác thực tạm thời; thử lại sau ${Math.ceil(delay/1000)}s`);
      const waited=await waitUntilStoppedOrDeadline(delay,stop,deadlineAt);
      if(waited==="stopped")return{account,win:null,skipped:true,detail:stop.reason||"TIN2 đã xác nhận"};
      continue;
    }

    // Các phản hồi mơ hồ (timeout/5xx/accepted-unverified) cần xác minh số dư.
    // Chỉ gửi lại sau khi refresh xác nhận số dư chưa thay đổi.
    if(["SERVER_ERROR","UNKNOWN_NETWORK","ACCEPTED_UNVERIFIED"].includes(result.status)||
       (result.status==="HTTP_ERROR"&&[408,425].includes(Number(result.httpStatus)))){
      verificationRequired=true;verifyBalanceBefore=balanceBeforeAttempt;
      addActivity("REDEEM_VERIFY_AFTER_ERROR",code,account.un,"CHECK",`${result.status} · kiểm tra số dư trước khi retry`);
      const refreshed=await account.refreshToken().catch(()=>false);
      if(refreshed){
        const pending=await makePendingAfterBalanceChange(account,code,balanceBeforeAttempt,result.status);
        if(pending)return pending;
        verificationRequired=false;
      }
    }

    const remaining=deadlineAt-Date.now();
    const delay=retryDelayFor(result,Math.max(1,retryIndex+1),remaining);
    if(!delay){
      const reason=result.status==="RATE_LIMITED"?"Retry-After vượt thời gian còn lại của cửa sổ 4 phút":
        result.status==="ACCEPTED_UNVERIFIED"?"API đã nhận nhưng chưa xác minh được; không gửi lại mù":
        `Lỗi ${result.status||"UNKNOWN"} không thuộc nhóm retry an toàn`;
      if(result.status==="ACCEPTED_UNVERIFIED"){
        account.lastRedeemStatus="PENDING_TIN2";
        addActivity("REDEEM_PENDING_TIN2",code,account.un,"WAITING",reason);
        return{account,win:null,skipped:false,pending:true,detail:reason};
      }
      addActivity("REDEEM_RETRY_STOP",code,account.un,"STOPPED",reason);
      return{account,win:null,skipped:false,detail:account.lastSummary||reason};
    }
    retryIndex++;
    stats.retryAttempts++;
    addActivity("REDEEM_RETRY_WAIT",code,account.un,"WAIT",`${result.status||"Lỗi tạm thời"}; chờ ${(delay/1000).toFixed(1)}s rồi thử tiếp · còn ${Math.max(0,Math.ceil((deadlineAt-Date.now())/1000))}s`);
    const waited=await waitUntilStoppedOrDeadline(delay,stop,deadlineAt);
    if(waited==="stopped")return{account,win:null,skipped:true,detail:stop.reason||"TIN2 xác nhận trong thời gian chờ"};
    if(waited==="deadline")break;
  }
  account.lastRedeemStatus="WINDOW_EXPIRED";
  account.lastSummary="HẾT CỬA SỔ 4 PHÚT · chưa có TIN2 xác nhận thành công";
  addActivity("REDEEM_WINDOW_EXPIRED",code,account.un,"TIMEOUT",account.lastSummary);
  return{account,win:null,skipped:false,detail:account.lastSummary};
}
async function runQueuedRedeem(job){
  if(!redeemState.enabled){addActivity("QUEUE_SKIPPED",job.code,"","AUTO_OFF","Auto đã tắt trước khi xử lý");upsertCodeHistory(job.code,{status:"SKIPPED_AUTO_OFF"});return;}
  syncRedeemAccounts();
  const mode=redeemState.redeem_mode==="single"?"single":"all";
  const selected=selectedRedeemAccount();
  const accounts=mode==="single"?(selected?[selected]:[]):REDEEM_ACCOUNTS.slice();
  if(!accounts.length){addActivity("QUEUE_FAILED",job.code,"","NO_ACCOUNT","Chưa có tài khoản game hợp lệ");upsertCodeHistory(job.code,{status:"NO_ACCOUNT",accounts:[]});await reportCodeFound(job.code,"Chưa có tài khoản game được chọn");return;}
  const started=Date.now();
  const detectedAt=Number(job.detectedAt||started);
  const deadlineAt=detectedAt+AUTO_REDEEM_WINDOW_MS;
  if(Date.now()>=deadlineAt){addActivity("REDEEM_WINDOW_EXPIRED",job.code,"","EXPIRED_IN_QUEUE","Mã đã chờ trong hàng đợi quá cửa sổ 4 phút");upsertCodeHistory(job.code,{status:"WINDOW_EXPIRED",finished_at:new Date().toISOString(),reason:"expired_in_queue"});return;}
  const stop={stopped:false,reason:null,controller:new AbortController(),deadlineReached:false};
  const run={stop,started:started/1000,deadlineAt,codes:[job.code],accounts:accounts.map(a=>a.un),tin2MatchedUser:null,tin2MatchedAt:null};
  const deadlineAbortTimer=setTimeout(()=>{
    stop.deadlineReached=true;
    try{stop.controller.abort();}catch{}
    addActivity("REDEEM_WINDOW_DEADLINE",job.code,"","TIMEOUT","Đủ 4 phút kể từ lúc phát hiện TIN1; hủy các request redeem còn đang chờ");
  },Math.max(0,deadlineAt-Date.now()));
  ACTIVE_RUNS.add(run);
  upsertCodeHistory(job.code,{status:"RUNNING",mode,accounts:accounts.map(a=>a.un),started_at:new Date(started).toISOString(),deadline_at:new Date(deadlineAt).toISOString()});
  addActivity("REDEEM_BATCH_START",job.code,"","STARTED",`Chạy ${accounts.length} tài khoản · mode=${mode} · song song tối đa ${MAX_PARALLEL_ACCOUNTS} · thời hạn đến ${new Date(deadlineAt).toISOString()}`);
  await bot.sendMessage(ADMIN_ID,`⚡ <b>TIN1 · BẮT ĐẦU AUTO REDEEM</b>\n${DIV}\n🎁 Mã: <code>${esc(job.code)}</code>\n👥 Tài khoản mục tiêu: <b>${accounts.length}</b>\n🚀 Song song tối đa: <b>${Math.min(accounts.length,MAX_PARALLEL_ACCOUNTS)}</b>\n⏱ Cửa sổ retry: <b>tối đa 4 phút</b> kể từ khi phát hiện TIN1\n🛑 Dừng ngay khi kênh phát TIN2 xác nhận có người nhận code (kể cả username ngoài).`,{parse_mode:"HTML"}).catch(()=>{});
  const results=[];
  try{
    // Mọi tài khoản bắt đầu cùng một lúc; semaphore chỉ giới hạn số request redeem
    // đang bay đồng thời, không giữ các tài khoản ở lô sau chờ hết 4 phút.
    const settled=await Promise.all(accounts.map(async account=>{
      let accountResult;
      try{accountResult=await redeemAccountWithRetries(account,job.code,stop,run);}
      catch(error){
        account.lastRedeemStatus="ACCOUNT_EXCEPTION";
        account.lastSummary=String(error?.message||error||"Lỗi tài khoản").slice(0,240);
        addActivity("REDEEM_ACCOUNT_EXCEPTION",job.code,account.un,"ERROR",account.lastSummary);
        accountResult={account,win:null,skipped:false,detail:account.lastSummary};
      }
      const history=redeemState.code_history.find(row=>String(row.code||"")===String(job.code));
      const accountResults=Array.isArray(history?.account_results)?history.account_results.slice():[];
      const snapshot={username:account.un,status:accountResult.win?"SUCCESS":(accountResult.pending?"PENDING_TIN2":(accountResult.skipped?"SKIPPED":String(account.lastRedeemStatus||"FAILED"))),detail:String(account.lastSummary||accountResult.detail||"").slice(0,240),amount:Number(accountResult.win?.amount||0),updated_at:new Date().toISOString()};
      persistAccountRedeemResult(account,job.code,accountResult);
      const existingIndex=accountResults.findIndex(row=>String(row.username||"").toLowerCase()===account.un.toLowerCase());
      if(existingIndex>=0)accountResults[existingIndex]=snapshot;else accountResults.push(snapshot);
      upsertCodeHistory(job.code,{status:"RUNNING",account_results:accountResults});
      return accountResult;
    }));
    results.push(...settled);
    for(const account of accounts){
      if(!results.some(x=>x.account===account))results.push({account,win:null,skipped:true,detail:stop.reason||(Date.now()>=deadlineAt?"Hết cửa sổ 4 phút":"Chưa gửi do TIN2 đã xác nhận")});
    }
    const elapsed=(Date.now()-started)/1000;
    const stopText=stop.stopped?`Dừng theo TIN2: ${run.tin2MatchedUser||stop.reason}`:`Cửa sổ xử lý kết thúc${Date.now()>=deadlineAt?" (đủ 4 phút)":""}`;
    await sendRedeemBatchSummary(job.code,results,elapsed,job.msgAge,mode);
    addActivity("REDEEM_BATCH_COMPLETE",job.code,"",stop.stopped?"STOPPED":"DONE",`${stopText}; ${elapsed.toFixed(2)}s`);
    upsertCodeHistory(job.code,{status:stop.stopped?"STOPPED_TIN2":(Date.now()>=deadlineAt?"WINDOW_EXPIRED":"COMPLETED"),finished_at:new Date().toISOString(),elapsed_sec:Number(elapsed.toFixed(2)),account_results:results.map(x=>({username:x.account?.un||"",status:x.win?"SUCCESS":(x.pending?"PENDING_TIN2":(x.skipped?"SKIPPED":String(x.account?.lastRedeemStatus||"FAILED"))),detail:String(x.account?.lastSummary||x.detail||"").slice(0,240),amount:Number(x.win?.amount||0)}))});
    if(!stop.stopped&&Date.now()>=deadlineAt){
      await bot.sendMessage(ADMIN_ID,`⏱ <b>HẾT 4 PHÚT AUTO REDEEM</b>\n${DIV}\nMã: <code>${esc(job.code)}</code>\nKênh chưa phát TIN2 xác nhận có người nhận code. Bot đã dừng retry cho mã này.`,{parse_mode:"HTML"}).catch(()=>{});
    }
  }finally{clearTimeout(deadlineAbortTimer);ACTIVE_RUNS.delete(run);}
}
async function drainRedeemQueue(){
  if(redeemQueueRunning)return;redeemQueueRunning=true;
  try{
    while(redeemQueue.length){
      const job=redeemQueue.shift();
      try{await runQueuedRedeem(job);}
      catch(error){
        const message=String(error?.stack||error?.message||error).slice(0,900);
        console.error(`[QUEUE] Job ${job.code} failed:`,message);
        addActivity("REDEEM_BATCH_EXCEPTION",job.code,"","ERROR",message);
        upsertCodeHistory(job.code,{status:"ERROR",error:String(error?.message||error).slice(0,300),finished_at:new Date().toISOString()});
        await bot.sendMessage(ADMIN_ID,`⚠️ <b>LỖI XỬ LÝ MÃ</b>\n${DIV}\nMã: <code>${esc(job.code)}</code>\n${esc(error?.message||error)}\n\nHàng đợi vẫn tiếp tục xử lý các mã khác.`,{parse_mode:"HTML"}).catch(()=>{});
      }finally{queuedCodes.delete(job.code);}
    }
  }finally{redeemQueueRunning=false;if(redeemQueue.length)void drainRedeemQueue().catch(error=>console.error("[QUEUE-RESTART]",error));}
}
async function redeemAllSimultaneous(variants,msgAge=null,messageId=null){
  const code=normalizeRedeemCode(variants?.[0]||"");if(!code)return;
  if(queuedCodes.has(code)){addActivity("DUPLICATE",code,"","SKIPPED","Mã này đang nằm trong hàng đợi");return;}
  if(redeemQueue.length>=MAX_REDEEM_QUEUE){addActivity("QUEUE_FULL",code,"","SKIPPED","Hàng đợi đầy; không nhận thêm tác vụ");upsertCodeHistory(code,{status:"QUEUE_FULL",message_id:messageId||null});await reportCodeFound(code,"Hàng đợi đang đầy — xem nhật ký");return;}
  const detectedAt=Date.now();
  queuedCodes.add(code);redeemQueue.push({code,msgAge,messageId,queuedAt:detectedAt,detectedAt});
  const mode=redeemState.redeem_mode==="single"?"single":"all";
  upsertCodeHistory(code,{status:"QUEUED",mode,message_id:messageId||null,queued_at:new Date(detectedAt).toISOString(),msg_age_sec:msgAge??null});
  const accounts=mode==="all"?REDEEM_ACCOUNTS.length:(selectedRedeemAccount()?1:0);
  addActivity("REDEEM_QUEUED",code,"","QUEUED",`Đã xếp hàng · mode=${mode} · ${accounts} tài khoản mục tiêu`);
  await bot.sendMessage(ADMIN_ID,`🧾 <b>TIN1 · ĐÃ XẾP HÀNG REDEEM</b>\n${DIV}\n🎁 <code>${esc(code)}</code>\n👥 Chế độ: <b>${mode==="all"?"TẤT CẢ ACC":"MỘT ACC"}</b>\n👤 Tài khoản mục tiêu: <b>${accounts}</b>\n📍 Vị trí hàng đợi: ${redeemQueue.length}`,{parse_mode:"HTML"}).catch(()=>{});
  void drainRedeemQueue().catch(error=>console.error("[QUEUE] drain failed:",error));
}
async function loginAndGetInfo(u,p){try{const pwHashed=normalizePw(p);const r=(await axios.get("https://apifo88daigia.tele68.com/api",{params:{c:"3",un:u,pw:pwHashed,cp:"R",cl:"R",pf:"web",at:""},timeout:10000,})).data;if(!r.success)return{_error:"Sai tài khoản hoặc mật khẩu"};const sk=r.sessionKey+"=".repeat((4-(r.sessionKey.length%4))%4);const nn=JSON.parse(Buffer.from(sk,"base64").toString("utf8")).nickname;const r2=(await axios.post("https://wlb.tele68.com/v1/lobby/auth/login?cp=R&cl=R&pf=web&at=",{nickName:nn,accessToken:r.accessToken},{timeout:10000})).data;if(!r2.token)return{_error:"Không nhận được token(có thể kẹt phiên)"};return{token:r2.token,nickname:nn,money:parseInt((r2.remoteLoginResp&&r2.remoteLoginResp.money)||0,10),pw_hashed:pwHashed,}}catch(e){return{_error:e.message}}}function upsertRedeemAccount(un,pwHashed,nick,ownerId,balance=0){redeemState.accounts=redeemState.accounts||[];let updated=false;for(const acc of redeemState.accounts){if(String(acc.un||"").toLowerCase()===un.toLowerCase()){acc.pw=pwHashed;acc.nick=nick;acc.owner=ownerId;acc.balance=parseInt(balance||0,10);updated=true;break}}if(!updated){redeemState.accounts.push({un,pw:pwHashed,nick,owner:ownerId,balance:parseInt(balance||0,10),added_at:new Date().toLocaleString("vi-VN"),})}if(!redeemState.active_account)redeemState.active_account=un;redeemState.allow_empty_accounts=false;saveRedeemState("account-upsert");reconcileRedeemAccounts()}function uptimeStr(){const s=Math.floor((Date.now()-bootTime)/1000);const h=Math.floor(s/3600);const m=Math.floor((s%3600)/60);return h>0?`${h}h ${m}m`:`${m}m ${s%60}s`}function authBadge(){
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
function accountSelectMenu(){
  const rows=REDEEM_ACCOUNTS.map((a,i)=>[{text:`${String(a.un).toLowerCase()===String(redeemState.active_account||"").toLowerCase()?"✅":"🎯"} ${a.un} · ${a.isTokenValid()?"TOKEN OK":"CẦN LOGIN"}`,callback_data:`rd_use:${i}`}]);
  rows.push([{text:"↩️ QUAY LẠI",callback_data:"rd_panel"}]);return{reply_markup:{inline_keyboard:rows}};
}
function mainMenu(){return{reply_markup:{inline_keyboard:[
  [{text:"⚡ AUTO REDEEM",callback_data:"rd_panel"}],
  [{text:"📡 TELEGRAM / KÊNH",callback_data:"tele_menu"}],
  [{text:"👥 TÀI KHOẢN GAME",callback_data:"rd_list"},{text:"📊 THỐNG KÊ",callback_data:"rd_stats"}],
  [{text:"📜 NHẬT KÝ",callback_data:"rd_logs"},{text:"🔄 LÀM MỚI",callback_data:"rd_refresh"}],
  [{text:"📄 XUẤT TOKEN (TXT)",callback_data:"export_tokens"}],
]}}}
function redeemMenu(){
  const toggle=redeemState.enabled?"🟢 TẮT AUTO":"🔴 BẬT AUTO";
  const allOn=redeemState.redeem_mode!=="single";
  return{reply_markup:{inline_keyboard:[
    [{text:toggle,callback_data:"rd_toggle"},{text:"📡 TELE / KÊNH",callback_data:"tele_menu"}],
    [{text:allOn?"✅ AUTO TẤT CẢ ACC":"🌐 AUTO TẤT CẢ ACC",callback_data:"rd_mode_all"},{text:!allOn?"✅ AUTO 1 ACC":"🎯 AUTO 1 ACC",callback_data:"rd_mode_one"}],
    [{text:"🔐 LOGIN TÀI KHOẢN",callback_data:"rd_login_acc"}],
    [{text:"🎯 CHỌN ACC (chế độ 1 acc)",callback_data:"rd_selectacc"}],
    [{text:"📋 DANH SÁCH",callback_data:"rd_list"},{text:"➖ XOÁ TÀI KHOẢN",callback_data:"rd_delacc"}],
    [{text:"📜 NHẬT KÝ CHI TIẾT",callback_data:"rd_logs"}],
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
  const online=REDEEM_ACCOUNTS.filter(a=>a.isTokenValid()).length;
  const active=selectedRedeemAccount();
  const watcher=channelMonitor.state==="watching"?"🟢 ĐANG ĐỌC":channelMonitor.state==="error"?"🔴 LỖI":"🟡 ĐANG KẾT NỐI";
  const lastPoll=channelMonitor.lastPollAt?new Date(channelMonitor.lastPollAt).toLocaleTimeString("vi-VN"):"chưa có";
  const lastCode=channelMonitor.lastCode?`<code>${esc(channelMonitor.lastCode)}</code>`:"chưa có";
  return `<b>⚡ LC79 · AUTO REDEEM CONTROL</b>\n${DIV2}\n`+
    `Auto: ${redeemState.enabled?"🟢 <b>ĐANG BẬT</b>":"⚪ <b>ĐANG TẮT</b>"}\n`+
    `Chế độ: <b>${redeemState.redeem_mode==="single"?"MỘT TÀI KHOẢN":"TẤT CẢ TÀI KHOẢN"}</b> · Mục tiêu: <b>${redeemState.redeem_mode==="single"?1:REDEEM_ACCOUNTS.length} acc</b>\n`+
    `Acc mặc định: <b>${esc(active?.un||"Chưa chọn")}</b> · Token: <b>${active?.isTokenValid()?"OK":"CẦN REFRESH"}</b>\n`+
    `Tổng acc lưu: <b>${REDEEM_ACCOUNTS.length}</b> · Token hợp lệ: <b>${online}</b>\n${DIV}\n`+
    `Telegram: <b>${authBadge()}</b>\nKênh: <b>${esc(redeemState.channel_name||"Chưa đặt")}</b>\n`+
    `Watcher: <b>${watcher}</b> · Poll: <code>${lastPoll}</code>\n`+
    (channelMonitor.lastError?`Lỗi kênh: <code>${esc(String(channelMonitor.lastError).slice(0,120))}</code>\n`:"")+
    `Mã mới nhất: ${lastCode}\n`+
    `Đã phát hiện: <b>${stats.codesSeen}</b> · Thành công API: <b>${stats.wins}</b> · Chưa thành công: <b>${stats.fails}</b>\n`+
    `TIN2 khớp acc: <b>${stats.tin2Matches}</b>\n`+
    `Hàng đợi: <b>${redeemQueue.length}</b> · Đang xử lý: <b>${redeemQueueRunning?"CÓ":"KHÔNG"}</b>\n${DIV}\n`+
    `<i>${redeemState.redeem_mode==="single"?"Chỉ acc đã chọn":"Tất cả acc đã lưu"} · mỗi acc tối đa một lượt request cho một mã; tối đa ${MAX_PARALLEL_ACCOUNTS} acc song song. Không spam request khi timeout.</i>`;
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
if(data==="rd_panel")return edit(panelText(),redeemMenu());
if(data==="rd_mode_all"){
  syncRedeemAccounts();
  if(!REDEEM_ACCOUNTS.length)return edit("📭 Chưa có tài khoản game để chạy chế độ tất cả.",redeemMenu());
  redeemState.redeem_mode="all";saveRedeemState("state-update");
  addActivity("REDEEM_MODE_CHANGED","","","ALL_ACCOUNTS",`Đã bật fan-out đồng thời cho ${REDEEM_ACCOUNTS.length} tài khoản; giới hạn ${MAX_PARALLEL_ACCOUNTS} acc/lượt`);
  return edit(`✅ <b>ĐÃ BẬT AUTO TẤT CẢ TÀI KHOẢN</b>\n${DIV}\nKhi có TIN1, bot sẽ gửi một request redeem tới từng acc đã lưu.\n👥 Tổng mục tiêu: <b>${REDEEM_ACCOUNTS.length} acc</b>\n🚀 Tối đa song song: <b>${Math.min(REDEEM_ACCOUNTS.length,MAX_PARALLEL_ACCOUNTS)}</b>\n🛡 Mỗi acc một lượt cho mỗi mã; không lặp request vô hạn.`,redeemMenu());
}
if(data==="rd_mode_one"){
  syncRedeemAccounts();
  if(!selectedRedeemAccount())return edit("📭 Chưa có tài khoản game.",redeemMenu());
  redeemState.redeem_mode="single";saveRedeemState("state-update");
  addActivity("REDEEM_MODE_CHANGED","",selectedRedeemAccount().un,"SINGLE_ACCOUNT","Chuyển sang chế độ một tài khoản");
  return edit(`✅ <b>ĐÃ BẬT CHẾ ĐỘ MỘT TÀI KHOẢN</b>\n${DIV}\nChỉ acc đã chọn mới nhận mã.`,redeemMenu());
}
if(data==="rd_selectacc"){syncRedeemAccounts();if(!REDEEM_ACCOUNTS.length)return edit("📭 Chưa có tài khoản game. Hãy đăng nhập tài khoản trước.",redeemMenu());return edit(`<b>🎯 CHỌN TÀI KHOẢN AUTO</b>\n${DIV}\nChọn acc tại đây sẽ tự chuyển sang chế độ MỘT ACC. Muốn chạy tất cả acc, bấm AUTO TẤT CẢ ACC.\n\nAcc hiện tại: <b>${esc(redeemState.active_account||"Chưa chọn")}</b>`,accountSelectMenu());}
if(data.startsWith("rd_use:")){const idx=Number(data.split(":")[1]);syncRedeemAccounts();const selected=REDEEM_ACCOUNTS[idx];if(!selected)return edit("⚠️ Tài khoản không còn tồn tại. Hãy mở lại danh sách.",redeemMenu());redeemState.active_account=selected.un;redeemState.redeem_mode="single";saveRedeemState("state-update");addActivity("ACTIVE_ACCOUNT_CHANGED","",selected.un,"SELECTED","Admin đổi tài khoản auto");return edit(`✅ <b>ĐÃ CHỌN TÀI KHOẢN AUTO</b>\n${DIV}\n👤 <code>${esc(selected.un)}</code>\n🔐 Token: ${selected.isTokenValid()?"🟢 Hợp lệ":"🟡 Cần refresh"}`,redeemMenu());}
if(data==="rd_logs"){const rows=redeemLogs.slice(-12).reverse();if(!rows.length)return edit("📭 Chưa có nhật ký. Khi phát hiện mã hoặc gửi redeem, log sẽ xuất hiện tại đây.",redeemMenu());const lines=rows.map(r=>{const tm=esc(r.time||"");const typ=esc(r.type||"REDEEM");const code=r.code?`<code>${esc(r.code)}</code>`:"—";const acc=r.account?`<code>${esc(maskAccount(r.account))}</code>`:"—";const st=esc(r.status||"—");const detail=esc(String(r.detail||"").slice(0,90));return `🕒 <code>${tm}</code> · <b>${typ}</b>\n🎁 ${code} · 👤 ${acc}\n📌 <b>${st}</b>${detail?`\n└ ${detail}`:""}`;});return edit(`<b>📜 NHẬT KÝ HOẠT ĐỘNG</b>\n${DIV2}\n${lines.join("\n\n")}\n${DIV}`,redeemMenu());}
if(data==="rd_stats"){const online=REDEEM_ACCOUNTS.filter((a)=>a.isTokenValid()).length;const totalBal=REDEEM_ACCOUNTS.reduce((s,a)=>s+(a.balance||0),0);return edit(`📊<b>THỐNG KÊ</b>\n${DIV2}\n`+`⏱ Uptime:<code>${uptimeStr()}</code>\n`+`👥 TK:${REDEEM_ACCOUNTS.length}· Token OK:${online}\n`+`💰 Tổng số dư:<b>${money(totalBal)}</b>\n`+`🎁 Code thấy:${stats.codesSeen}\n`+`✅ Win API:${stats.wins}· ❌ Miss:${stats.fails}\n`+`📣 TIN2 khớp acc:${stats.tin2Matches}\n`+`🔁 Retry:${stats.retryAttempts}\n`+`⚙️ Mode:${redeemState.redeem_mode==="single"?"1 ACC":"ALL ACC"}\n`+(stats.lastCode?`📝 Mã gần nhất:<code>${esc(stats.lastCode)}</code>\n`:"")+(stats.lastWinAt?`🏆 Win gần nhất:${new Date(stats.lastWinAt).toLocaleString("vi-VN")}\n`:"")+`${DIV}\n<i>${VERSION}</i>`,mainMenu())}if(data==="rd_toggle"){
  syncRedeemAccounts();
  if(redeemState.enabled)redeemState.enabled=false;
  else if(!REDEEM_ACCOUNTS.length)return edit("⚠️ Chưa có tài khoản game. Hãy đăng nhập tài khoản trước.",redeemMenu());
  else if(!redeemState.channel_id)return edit("⚠️ Chưa chọn kênh nguồn. Hãy vào Telegram / Kênh để đặt kênh.",teleMenu());
  else if(teleAuthStatus.state!=="authorized"||!teleClient)return edit("⚠️ Tài khoản Telegram chưa được xác thực. Hãy kiểm tra session hoặc đăng nhập lại.",teleMenu());
  else if(redeemState.channel_joined!==true||redeemState.channel_join_pending)return edit("⚠️ Tài khoản chưa được xác minh là thành viên của kênh. Bấm KIỂM TRA / TỰ THAM GIA trước.",teleMenu());
  else redeemState.enabled=true;
  saveRedeemState("state-update");return edit(panelText(),redeemMenu());
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
  teleHandlerClient=null;
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
}if(flow.step==="admin_login_game"){const parts=value.split(/\s+/);if(parts.length<2){return bot.sendMessage(cid,"⚠️ Gửi:<code>TÀI_KHOẢN MẬT_KHẨU</code>",{parse_mode:"HTML",})}const un=parts[0];const pw=parts.slice(1).join(" ");const status=await bot.sendMessage(cid,`🔄 Đang đăng nhập<code>${esc(un)}</code>…`,{parse_mode:"HTML",});const res=await loginAndGetInfo(un,pw);if(res._error){userFlows[cid]=null;return bot.editMessageText(`❌ ${esc(res._error)}`,{chat_id:cid,message_id:status.message_id,parse_mode:"HTML",...redeemMenu(),})}upsertRedeemAccount(un,res.pw_hashed,res.nickname,cid,res.money);userFlows[cid]=null;return bot.editMessageText(`✅<b>ĐĂNG NHẬP THÀNH CÔNG</b>\n${DIV2}\n`+`🔑 Tên đăng nhập:<code>${esc(un)}</code>\n`+`👤 Nickname:<b>${esc(res.nickname)}</b>\n`+`💰 Số dư:<b>${money(res.money)}</b>\n`+`⚡ Đã sẵn sàng lụm code.`,{chat_id:cid,message_id:status.message_id,parse_mode:"HTML",...redeemMenu()})}if(flow.step==="admin_del_redeem"){const key=value.toLowerCase();const before=(redeemState.accounts||[]).length;redeemState.accounts=(redeemState.accounts||[]).filter((a)=>String(a.un||"").toLowerCase()!==key&&String(a.nick||"").toLowerCase()!==key);if(!redeemState.accounts.some(a=>String(a.un||"").toLowerCase()===String(redeemState.active_account||"").toLowerCase()))redeemState.active_account=redeemState.accounts[0]?.un||"";redeemState.allow_empty_accounts=redeemState.accounts.length===0;allowAccountRemovalOnce=true;saveRedeemState("admin-delete-account");reconcileRedeemAccounts();userFlows[cid]=null;const removed=before-redeemState.accounts.length;return bot.sendMessage(cid,removed?`✅ Đã xoá<b>${removed}</b>tài khoản.`:"⚠️ Không tìm thấy.",{parse_mode:"HTML",...redeemMenu()})}});function saveTeleSession(session){
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
  channelCacheValue="";channelCacheId="";channelEntityCache=null;channelEntityCacheClient=null;
  teleHandlerAttached=false;
  teleHandlerClient=null;
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
    if(!teleClient.connected)await teleClient.connect();
    if(!(await teleClient.checkAuthorization())){
      try{await teleClient.disconnect()}catch{}
      teleClient=null;teleHandlerAttached=false;teleHandlerClient=null;channelCacheValue="";channelCacheId="";channelEntityCache=null;channelEntityCacheClient=null;
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
  if(channelCacheValue===configured&&channelEntityCache&&channelEntityCacheClient===teleClient)return channelEntityCache;
  channelEntityCache=null;channelEntityCacheClient=null;
  let entity=null;
  if(/^@/.test(configured))entity=await teleClient.getEntity(configured);
  else entity=await findDialogChannelById(configured);
  if(!entity && /^-?\d+$/.test(configured))entity=await teleClient.getEntity(Number(configured)).catch(()=>null);
  if(!entity && redeemState.channel_username)entity=await teleClient.getEntity('@'+redeemState.channel_username).catch(()=>null);
  if(entity&&isChannelEntity(entity)){channelCacheValue=configured;channelCacheId=normalizeChannelId(entity.id?.toString?.()??entity.id);channelEntityCache=entity;channelEntityCacheClient=teleClient;}else if(entity){console.warn("[TELE] Entity được cấu hình không phải Channel; sẽ không cache.");entity=null;}
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
  const previousId=String(redeemState.channel_id||"");
  if(previousId && normalizeChannelId(previousId)!==normalizeChannelId(id)){
    redeemState.channel_cursor_channel_id=null;
    redeemState.channel_last_message_id=0;
  }
  redeemState.channel_id=id;
  redeemState.channel_name=channelEntityName(entity);
  redeemState.channel_username=entity?.username||"";
  redeemState.channel_link=link|| (entity?.username?`https://t.me/${entity.username}`:"");
  redeemState.channel_joined=!!joined;
  redeemState.channel_join_pending=false;
  redeemState.channel_checked_at=new Date().toISOString();
  channelCacheValue=String(id);channelCacheId=normalizeChannelId(id);channelEntityCache=entity;channelEntityCacheClient=teleClient;
  saveRedeemState("state-update");
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
        channelCacheValue=String(redeemState.channel_id);channelCacheId=normalizeChannelId(redeemState.channel_id);channelEntityCache=entity;channelEntityCacheClient=teleClient;
        saveRedeemState("state-update");
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
        redeemState.channel_joined=false;redeemState.channel_join_pending=true;redeemState.enabled=false;saveRedeemState("state-update");
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
let lastUpdateAt=0;
function messageTextOf(message){
  return String(message?.message??message?.text??message?.caption??"").trim();
}
function messageChatIdOf(message){
  if(message?.chatId!==undefined&&message?.chatId!==null)return String(message.chatId);
  const peer=message?.peerId;
  if(peer?.channelId!==undefined&&peer?.channelId!==null)return `-100${String(peer.channelId)}`;
  if(peer?.chatId!==undefined&&peer?.chatId!==null)return `-${String(peer.chatId)}`;
  if(peer?.userId!==undefined&&peer?.userId!==null)return String(peer.userId);
  return "";
}
function messageAgeSeconds(message){
  const raw=message?.date;
  if(raw instanceof Date)return Math.max(0,Date.now()/1000-raw.getTime()/1000);
  const n=Number(raw);
  if(!Number.isFinite(n)||n<=0)return null;
  return Math.max(0,Date.now()/1000-(n>1e12?n/1000:n));
}
async function reportCodeFound(code,reason){
  const msg=`🔔 <b>TIN1 · KÊNH VỪA PHÁT CODE MỚI</b>\n${DIV}\nMã: <code>${esc(code)}</code>\n${reason?`Trạng thái: ${esc(reason)}`:"Đang chuyển sang xử lý redeem."}`;
  try{await bot.sendMessage(ADMIN_ID,msg,{parse_mode:"HTML"})}catch(e){console.warn("[BOT] Không gửi được thông báo phát hiện mã:",e.message)}
}
async function processChannelMessage(message,source="event"){
  let processingCode="";
  const rawText=messageTextOf(message);
  if(!rawText)return false;
  const msgId=Number(message?.id||0);
  const configuredId=String(redeemState.channel_id||"");
  const stableKey=`${normalizeChannelId(configuredId)}:${msgId||hashStr(rawText)}`;
  if(processingChannelMessages.has(stableKey))return false;
  processingChannelMessages.add(stableKey);
  try{
    if(source!=="poll"){
      const chatId=messageChatIdOf(message);
      const targetChannelId=await getTargetChannelId();
      if(!targetChannelId||!chatId||normalizeChannelId(chatId)!==targetChannelId)return false;
    }
    lastUpdateAt=Date.now();
    channelMonitor.lastUpdateAt=lastUpdateAt;
    channelMonitor.lastError=null;
    if(await handleAnnouncement(rawText,msgId))return true;
    const variants=codeVariants(rawText);
    if(variants.length)processingCode=variants[0];
    if(!variants.length){
      if(/\bLC79\b|mã\s*code|gift\s*code/i.test(rawText))addActivity("MESSAGE_NO_CODE","","","FILTERED",`Đã đọc bài #${msgId||"?"} nhưng không tách được mã: ${rawText.slice(0,180).replace(/\s+/g," ")}`);
      return false;
    }
    const now=Date.now()/1000;
    for(const key of Object.keys(RECENT_CODES))if(now-RECENT_CODES[key]>6*3600)delete RECENT_CODES[key];
    const savedCodes=Array.isArray(redeemState.recent_codes)?redeemState.recent_codes:[];
    const recoverableStatuses=new Set(["DETECTED","ERROR","QUEUE_SETUP_ERROR","QUEUE_FULL"]);
    const duplicate=variants.some(code=>{
      if(RECENT_CODES[code])return true;
      const previous=savedCodes.filter(row=>String(row.code||"")===code&&now-Number(row.at||0)<6*3600);
      const history=(redeemState.code_history||[]).find(row=>String(row.code||"")===code);
      const latestStatus=String(history?.status||previous[previous.length-1]?.status||"PROCESSED");
      // Chỉ mã chưa xếp hàng hoặc lỗi xếp hàng mới được khôi phục; mã đã chạy/hoàn tất không gửi trùng.
      return previous.length>0&&!recoverableStatuses.has(latestStatus);
    });
    if(duplicate){
      addActivity("CODE_DUPLICATE",variants[0],"","SKIPPED","Mã đã được phát hiện trong 6 giờ gần nhất (kể cả sau restart); không gửi request trùng");
      console.log(`[CODE] bỏ qua mã trùng gần đây: ${variants.join("/")}`);
      return false;
    }
    for(const code of variants)RECENT_CODES[code]=now;
    redeemState.recent_codes=[...savedCodes.filter(row=>now-Number(row.at||0)<6*3600),...variants.map(code=>({code,at:now,message_id:msgId||null,status:"DETECTED"}))].slice(-200);
    redeemState.last_detected_code=variants[0];
    redeemState.last_detected_code_at=now;
    const msgAge=messageAgeSeconds(message);
    saveRedeemState("code-detected");
    upsertCodeHistory(variants[0],{status:"DETECTED",message_id:msgId||null,source,detected_at:new Date(now*1000).toISOString(),message_age_sec:msgAge??null,channel_id:String(redeemState.channel_id||"")});
    channelMonitor.lastCode=variants[0];
    channelMonitor.lastMessageId=msgId||channelMonitor.lastMessageId;
    channelMonitor.lastCodeAt=Date.now();
    stats.codesSeen++;
    stats.lastCode=variants[0];
    stats.lastDetectedAt=Date.now();
    addActivity("CODE_DETECTED",variants[0],"","FOUND",`Nguồn ${source} · message #${msgId||"?"} · tuổi ${msgAge==null?"?":msgAge.toFixed(1)+"s"}`);
    console.log(`[CHANNEL:${source}] nhận bài #${msgId||"?"} · ${variants.join("/")} · age=${msgAge==null?"?":msgAge.toFixed(1)+"s"}`);
    if(!redeemState.enabled){
      upsertCodeHistory(variants[0],{status:"SKIPPED_AUTO_OFF"});
      await reportCodeFound(variants.join(" / "),"AUTO REDEEM đang TẮT — mã được ghi log nhưng không gửi request");
      return true;
    }
    if(redeemState.channel_joined!==true||redeemState.channel_join_pending){
      upsertCodeHistory(variants[0],{status:"SKIPPED_CHANNEL_NOT_JOINED"});
      await reportCodeFound(variants.join(" / "),"Tài khoản Telegram chưa được xác minh đã tham gia kênh");
      return true;
    }
    syncRedeemAccounts();
    if(!REDEEM_ACCOUNTS.length){
      upsertCodeHistory(variants[0],{status:"NO_ACCOUNT"});
      await reportCodeFound(variants.join(" / "),"Chưa có tài khoản game để redeem");
      return true;
    }
    const mode=redeemState.redeem_mode==="single"?"single":"all";
    const targetCount=mode==="all"?REDEEM_ACCOUNTS.length:(selectedRedeemAccount()?1:0);
    if(!targetCount){
      upsertCodeHistory(variants[0],{status:"NO_TARGET_ACCOUNT"});
      await reportCodeFound(variants.join(" / "),mode==="all"?"Chưa có tài khoản game để redeem":"Chưa chọn tài khoản auto");
      return true;
    }
    try{
      await bot.sendMessage(ADMIN_ID,`📥 <b>TIN1 · BẮT ĐẦU REDEEM</b>\n${DIV}\n🎁 <code>${esc(variants.join(" / "))}</code>\n🕐 Tin mới ${msgAge!=null?msgAge.toFixed(1)+" giây":"không rõ thời gian"}\n👥 Chế độ: <b>${mode==="all"?"TẤT CẢ ACC":"MỘT ACC"}</b> · mục tiêu <b>${targetCount} acc</b>`,{parse_mode:"HTML"});
    }catch{}
    void redeemAllSimultaneous(variants,msgAge,msgId).catch(error=>{
      console.error("[CODE-HANDLER] Queue setup failed:",error?.stack||error);
      addActivity("CODE_QUEUE_SETUP_ERROR",variants[0],"","ERROR",String(error?.message||error));
      upsertCodeHistory(variants[0],{status:"QUEUE_SETUP_ERROR",error:String(error?.message||error).slice(0,300)});
    });
    return true;
  }catch(error){
    channelMonitor.lastError=String(error?.message||error);
    if(processingCode)upsertCodeHistory(processingCode,{status:"ERROR",error:channelMonitor.lastError.slice(0,300),updated_at:new Date().toISOString()});
    console.error(`[CHANNEL:${source}] xử lý bài lỗi:`,error);
    await diag(`Lỗi xử lý bài đăng kênh: ${esc(channelMonitor.lastError)}`);
    return false;
  }finally{
    processingChannelMessages.delete(stableKey);
  }
}
async function pollTargetChannelOnce(){
  if(channelPollBusy)return;
  channelPollBusy=true;
  try{
    if(!TELETHON_API_ID||!TELETHON_API_HASH||!loadTeleSession())return;
    if(!teleClient||!teleClient.connected)await ensureTeleClient();
    const entity=await getTargetChannelEntity();
    if(!entity)throw new Error("Không phân giải được kênh nguồn. Kiểm tra lại username/ID và quyền tham gia.");
    const channelId=normalizeChannelId(entity.id?.toString?.()??entity.id);
    const cursorChannel=String(redeemState.channel_cursor_channel_id||"");
    let cursor=Number(redeemState.channel_last_message_id||0);
    if(cursorChannel!==channelId||!Number.isFinite(cursor)||cursor<0){
      const recent=await teleClient.getMessages(entity,{limit:20});
      const ordered=[...(recent||[])].sort((a,b)=>Number(a.id)-Number(b.id));
      const latestId=ordered.length?Number(ordered[ordered.length-1]?.id||0):0;
      let recovered=0;
      const newestCodeMessage=[...ordered].reverse().find(message=>{
        const age=messageAgeSeconds(message);
        return codeVariants(messageTextOf(message)).length>0&&age!=null&&age<=MAX_RECENT_BOOTSTRAP_AGE_SEC;
      });
      if(newestCodeMessage){
        const newestCodeId=Number(newestCodeMessage.id||0);
        const recoverable=ordered.filter(message=>{
          const id=Number(message?.id||0);const age=messageAgeSeconds(message);
          if(age==null||age>MAX_RECENT_BOOTSTRAP_AGE_SEC||id<newestCodeId)return false;
          const text=messageTextOf(message);
          return codeVariants(text).length>0||isSuccessAnnouncement(text);
        });
        for(const message of recoverable){await processChannelMessage(message,"bootstrap");recovered++;}
      }
      redeemState.channel_cursor_channel_id=channelId;
      redeemState.channel_last_message_id=latestId;
      saveRedeemState("state-update");
      channelMonitor.state="watching";
      channelMonitor.lastPollAt=Date.now();
      channelMonitor.lastMessageId=latestId;
      channelMonitor.lastError=null;
      addActivity("CHANNEL_BOOTSTRAP","","","OK",`Đọc ${ordered.length} bài gần nhất; khôi phục ${recovered} bài có code trong ${Math.round(MAX_RECENT_BOOTSTRAP_AGE_SEC/60)} phút gần đây`);
      console.log(`[CHANNEL-POLL] bootstrap channel=${channelId} · latest=${latestId} · recovered=${recovered}`);
      return;
    }
    const messages=await teleClient.getMessages(entity,{limit:100,minId:cursor});
    const fresh=[...(messages||[])].filter(m=>Number(m?.id||0)>cursor).sort((a,b)=>Number(a.id)-Number(b.id));
    for(const message of fresh){
      await processChannelMessage(message,"poll");
      const id=Number(message?.id||0);
      if(id>cursor){
        cursor=id;
        redeemState.channel_last_message_id=cursor;
        redeemState.channel_cursor_channel_id=channelId;
        saveRedeemState("state-update");
      }
    }
    channelMonitor.state="watching";
    channelMonitor.lastPollAt=Date.now();
    channelMonitor.lastMessageId=cursor;
    channelMonitor.lastError=null;
    if(fresh.length)console.log(`[CHANNEL-POLL] đọc bù ${fresh.length} bài mới · cursor=${cursor}`);
  }catch(error){
    channelMonitor.state="error";
    channelMonitor.lastPollAt=Date.now();
    const pollError=String(error?.message||error);
    if(channelMonitor.lastError!==pollError)addActivity("CHANNEL_POLL_ERROR","","","ERROR",pollError);
    channelMonitor.lastError=pollError;
    console.error("[CHANNEL-POLL]",error?.stack||error);
    await diag(`Không đọc được kênh nguồn: ${esc(channelMonitor.lastError)}`);
  }finally{
    channelPollBusy=false;
  }
}
function startChannelPoller(){
  if(channelPollTimer)return;
  channelPollTimer=setInterval(()=>{pollTargetChannelOnce().catch(error=>console.error("[CHANNEL-POLL-TIMER]",error))},CHANNEL_POLL_MS);
  if(typeof channelPollTimer.unref==="function")channelPollTimer.unref();
}
async function startTeleListener(){
  if(!TELETHON_API_ID||!TELETHON_API_HASH){console.warn("Thiếu TELETHON_API_ID/HASH — bỏ qua canh kênh.");return false;}
  if(!teleClient&&!loadTeleSession()){teleAuthStatus={state:"missing",username:null,userId:null,checkedAt:Date.now(),error:null};console.warn("Chưa có Telegram StringSession.");return false;}
  try{
    await ensureTeleClient();
    await teleClient.getDialogs({limit:500}).then(d=>console.log("[TELE] đã nạp "+d.length+" hội thoại")).catch(e=>console.warn("[TELE] getDialogs:",e.message));
    if(!teleHandlerAttached||teleHandlerClient!==teleClient){
      const handler=async(event)=>{
        const message=event?.message;
        const chatId=event?.chatId??messageChatIdOf(message);
        console.log(`[TELE-RAW] chat=${chatId??"?"} msg=${message?.id??"?"} text=${messageTextOf(message).slice(0,100).replace(/\n/g," ")}`);
        await processChannelMessage(message,"event");
      };
      teleClient.addEventHandler(handler,new NewMessage({}));
      if(typeof EditedMessage==="function")teleClient.addEventHandler(handler,new EditedMessage({}));
      teleHandlerAttached=true;
      teleHandlerClient=teleClient;
      console.log("[TELE] NewMessage/EditedMessage listener attached");
    }
    startChannelPoller();
    await pollTargetChannelOnce();
    channelMonitor.state=channelMonitor.lastError?"error":"watching";
    console.log(`✅ GramJS connected as ${teleAuthStatus.username?"@"+teleAuthStatus.username:teleAuthStatus.userId||"authorized user"} · channel monitor ${channelMonitor.state}`);
    return true;
  }catch(e){
    channelMonitor.state="error";
    channelMonitor.lastError=String(e?.message||e);
    console.error("Tele listener:",e?.stack||e);
    return false;
  }
}
setInterval(async()=>{
  if(!TELETHON_API_ID||!redeemState.channel_id||!loadTeleSession())return;
  try{
    if(!teleClient||!teleClient.connected||teleHandlerClient!==teleClient){
      console.warn("[WATCHDOG] Telegram listener mất kết nối/chưa gắn handler, đang khôi phục…");
      await ensureTeleClient();
      await startTeleListener();
      console.log("[WATCHDOG] Đã kiểm tra và khôi phục listener");
    }else if(!channelPollTimer){
      startChannelPoller();
    }
  }catch(e){
    channelMonitor.state="error";
    channelMonitor.lastError=String(e?.message||e);
    console.error("[WATCHDOG]",e?.stack||e);
    await diag(`Watchdog Telegram lỗi: ${esc(channelMonitor.lastError)}`);
  }
},30000);
const server=http.createServer((req,res)=>{
  if(req.url==="/health"||req.url==="/healthz"){
    res.writeHead(200,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});
    res.end(JSON.stringify({status:"online",version:VERSION,enabled:!!redeemState.enabled,accounts:REDEEM_ACCOUNTS.length,redeemMode:redeemState.redeem_mode||"all",targetAccounts:redeemState.redeem_mode==="single"?1:REDEEM_ACCOUNTS.length,activeAccount:maskAccount(redeemState.active_account||""),telegram:teleAuthStatus.state,channel:redeemState.channel_name||null,channelJoined:redeemState.channel_joined??null,queue:{size:redeemQueue.length,running:redeemQueueRunning},activeRuns:[...ACTIVE_RUNS].map(r=>({code:r.codes?.[0]||"",remainingSec:Math.max(0,Math.ceil((r.deadlineAt-Date.now())/1000)),stopped:!!r.stop?.stopped,reason:r.stop?.reason||null,accounts:r.accounts||[]})),autoRedeemWindowSec:AUTO_REDEEM_WINDOW_MS/1000,stats,monitor:channelMonitor,uptime:uptimeStr()}));return;
  }
  if(req.url==="/api/dashboard"){
    res.writeHead(200,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});
    const recent=redeemLogs.slice(-35).reverse().map(r=>({time:r.time||"",type:r.type||"REDEEM",code:r.code||"",account:maskAccount(r.account||""),status:r.status||"",detail:String(r.detail||"").slice(0,240),amount:Number(r.amount||0)}));
    res.end(JSON.stringify({version:VERSION,enabled:!!redeemState.enabled,redeemMode:redeemState.redeem_mode||"all",targetAccounts:redeemState.redeem_mode==="single"?1:REDEEM_ACCOUNTS.length,accounts:REDEEM_ACCOUNTS.length,accountDetails:REDEEM_ACCOUNTS.map(a=>({username:maskAccount(a.un),tokenValid:a.isTokenValid(),lastSummary:String(a.lastSummary||"").slice(0,100)})),activeAccount:maskAccount(redeemState.active_account||""),token:teleAuthStatus.state,channel:redeemState.channel_name||"Chưa đặt",channelJoined:channelBadge(),watcher:channelMonitor.state,lastPoll:channelMonitor.lastPollAt,lastError:channelMonitor.lastError,lastCode:channelMonitor.lastCode,stats,queue:redeemQueue.length,running:redeemQueueRunning,activeRuns:[...ACTIVE_RUNS].map(r=>({code:r.codes?.[0]||"",remainingSec:Math.max(0,Math.ceil((r.deadlineAt-Date.now())/1000)),stopped:!!r.stop?.stopped,reason:r.stop?.reason||null,accounts:r.accounts||[]})),autoRedeemWindowSec:AUTO_REDEEM_WINDOW_MS/1000,uptime:uptimeStr(),recent}));return;
  }
  const html=`<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#111820"><title>LC79 · Redeem Console</title><style>
  :root{color-scheme:dark;--bg:#0d1319;--panel:#151e27;--panel2:#101820;--line:#293743;--muted:#91a0ad;--text:#e8eef2;--accent:#61c7a5;--warn:#d5ad69;--bad:#d87979}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif}.wrap{width:min(1120px,100%);margin:0 auto;padding:26px 18px 40px}.top{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:20px}.brand{display:flex;align-items:center;gap:13px}.mark{width:42px;height:42px;border:1px solid #375247;background:#172a25;display:grid;place-items:center;color:var(--accent);font-weight:900}.eyebrow{font-size:10px;letter-spacing:.16em;color:var(--muted);font-weight:800}.title{font-size:22px;font-weight:800;letter-spacing:-.04em}.build{color:var(--muted);font:11px ui-monospace,monospace}.state{display:flex;align-items:center;gap:8px;border:1px solid var(--line);padding:8px 11px;background:var(--panel2);font-size:12px}.dot{width:7px;height:7px;background:var(--accent);display:inline-block}.grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px}.metric,.panel{border:1px solid var(--line);background:var(--panel);padding:16px}.metric small{color:var(--muted);display:block;font-size:11px}.metric strong{display:block;margin-top:6px;font-size:23px;letter-spacing:-.04em}.layout{display:grid;grid-template-columns:minmax(0,1fr) minmax(330px,.9fr);gap:12px;margin-top:12px}.heading{font-size:11px;color:var(--muted);letter-spacing:.12em;font-weight:800;margin-bottom:12px}.rows{display:grid;gap:0}.rowline{display:flex;justify-content:space-between;gap:16px;padding:10px 0;border-bottom:1px solid var(--line)}.rowline:last-child{border-bottom:0}.rowline span{color:var(--muted)}.rowline b{text-align:right;overflow-wrap:anywhere}.pill{display:inline-block;border:1px solid var(--line);padding:3px 7px;font-size:10px;color:var(--muted)}.ok{color:var(--accent)}.warning{color:var(--warn)}.bad{color:var(--bad)}.logs{display:grid;gap:8px;max-height:560px;overflow:auto}.account-list{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.account-card{border:1px solid var(--line);background:var(--panel2);padding:10px 12px;min-width:0}.account-card b{display:block;overflow-wrap:anywhere}.account-card small{color:var(--muted)}@media(max-width:760px){.account-list{grid-template-columns:1fr 1fr}}@media(max-width:420px){.account-list{grid-template-columns:1fr}}.log{border:1px solid var(--line);background:var(--panel2);padding:10px 11px}.logtop{display:flex;justify-content:space-between;gap:10px;color:var(--muted);font-size:10px}.logcode{font:600 13px ui-monospace,monospace;margin-top:5px;word-break:break-word}.logmeta{font-size:11px;color:var(--muted);margin-top:3px}.detail{font-size:11px;color:#c0ccd4;margin-top:5px;overflow-wrap:anywhere}.foot{color:#63717c;text-align:center;font-size:10px;margin-top:16px}.empty{color:var(--muted);padding:18px;text-align:center;border:1px dashed var(--line)}@media(max-width:760px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.layout{grid-template-columns:1fr}.wrap{padding:18px 12px 30px}.top{align-items:flex-start}.title{font-size:19px}}@media(max-width:380px){.metric{padding:12px}.metric strong{font-size:20px}.build{display:none}}
  </style></head><body><main class="wrap"><header class="top"><div class="brand"><div class="mark">79</div><div><div class="eyebrow">LC79 AUTOMATION</div><div class="title">Redeem Console</div></div></div><div class="state"><span class="dot" id="dot"></span><b id="service">ĐANG TẢI</b></div></header><section class="grid"><div class="metric"><small>MÃ ĐÃ PHÁT HIỆN</small><strong id="codes">—</strong></div><div class="metric"><small>THÀNH CÔNG</small><strong id="wins">—</strong></div><div class="metric"><small>CHƯA THÀNH CÔNG</small><strong id="fails">—</strong></div><div class="metric"><small>TÀI KHOẢN ĐÃ LƯU</small><strong id="accounts">—</strong></div><div class="metric"><small>TIN2 KHỚP TÀI KHOẢN</small><strong id="tin2">—</strong></div></section><section class="panel" style="margin-top:12px"><div class="heading">TRẠNG THÁI TỪNG TÀI KHOẢN</div><div class="account-list" id="account-list"><div class="empty">Đang tải tài khoản…</div></div></section><section class="layout"><div class="panel"><div class="heading">TRẠNG THÁI HỆ THỐNG</div><div class="rows"><div class="rowline"><span>Auto redeem</span><b id="auto">—</b></div><div class="rowline"><span>Tài khoản auto</span><b id="active">—</b></div><div class="rowline"><span>Telegram session</span><b id="telegram">—</b></div><div class="rowline"><span>Kênh nguồn</span><b id="channel">—</b></div><div class="rowline"><span>Quyền truy cập kênh</span><b id="joined">—</b></div><div class="rowline"><span>Channel watcher</span><b id="watcher">—</b></div><div class="rowline"><span>Lần poll gần nhất</span><b id="poll">—</b></div><div class="rowline"><span>Mã mới nhất</span><b id="lastcode">—</b></div><div class="rowline"><span>Retry đã thực hiện</span><b id="retry">—</b></div><div class="rowline"><span>Cửa sổ auto redeem</span><b id="window">—</b></div><div class="rowline"><span>Hàng đợi</span><b id="queue">—</b></div><div class="rowline"><span>Uptime</span><b id="uptime">—</b></div></div><div class="detail bad" id="error"></div><div class="foot">Tự cập nhật mỗi 3 giây · /health và /api/dashboard</div></div><div class="panel"><div class="heading">NHẬT KÝ TRỰC TIẾP</div><div class="logs" id="logs"><div class="empty">Đang tải nhật ký…</div></div></div></section><div class="foot" id="version"></div></main><script>
  const $=id=>document.getElementById(id);const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));const time=v=>v?new Date(v).toLocaleTimeString("vi-VN"):"—";
  async function refresh(){try{const r=await fetch('/api/dashboard',{cache:'no-store'});if(!r.ok)throw new Error('HTTP '+r.status);const d=await r.json();$('service').textContent='SERVICE ONLINE';$('dot').className='dot';$('codes').textContent=d.stats?.codesSeen??0;$('wins').textContent=d.stats?.wins??0;$('fails').textContent=d.stats?.fails??0;$('accounts').textContent=d.accounts??0;$('tin2').textContent=d.stats?.tin2Matches??0;$('auto').innerHTML=d.enabled?'<span class="ok">ĐANG BẬT</span>':'<span class="warning">ĐANG TẮT</span>';$('active').textContent=(d.redeemMode==='all'?'TẤT CẢ ACC · '+(d.targetAccounts??d.accounts):'1 ACC · '+(d.activeAccount||'Chưa chọn'));$('telegram').innerHTML=d.token==='authorized'?'<span class="ok">ĐÃ XÁC THỰC</span>':'<span class="warning">'+esc(d.token)+'</span>';$('channel').textContent=d.channel||'Chưa đặt';$('joined').textContent=d.channelJoined||'—';$('watcher').textContent=d.watcher||'—';$('poll').textContent=time(d.lastPoll);$('lastcode').textContent=d.lastCode||'—';$('retry').textContent=d.stats?.retryAttempts??0;const activeRun=(d.activeRuns||[])[0];$('window').textContent=activeRun?(activeRun.stopped?'ĐÃ DỪNG · TIN2':Math.floor(activeRun.remainingSec/60)+':'+String(activeRun.remainingSec%60).padStart(2,'0')+' còn lại'):'Tối đa 04:00 / mã';$('queue').textContent=(d.queue??0)+(d.running?' · ĐANG CHẠY':'');$('uptime').textContent=d.uptime||'—';$('error').textContent=d.lastError?'Lỗi watcher: '+d.lastError:'';$('version').textContent=(d.version||'')+' · Chế độ: '+(d.redeemMode==='all'?'TẤT CẢ ACC':'MỘT ACC');const accts=(d.accountDetails||[]).map(a=>'<article class=\"account-card\"><b>'+esc(a.username)+'</b><small>'+(a.tokenValid?'TOKEN OK':'CẦN LOGIN')+'</small><div class=\"detail\">'+esc(a.lastSummary||'Chưa có lần redeem')+'</div></article>').join('');$('account-list').innerHTML=accts||'<div class=\"empty\">Chưa có tài khoản game.</div>';const logs=(d.recent||[]).map(x=>'<article class="log"><div class="logtop"><span>'+esc(x.time)+' · '+esc(x.type)+'</span><span>'+esc(x.status)+'</span></div><div class="logcode">'+esc(x.code||'HOẠT ĐỘNG')+'</div><div class="logmeta">Tài khoản: '+esc(x.account||'—')+' · +'+Number(x.amount||0).toLocaleString('vi-VN')+'</div>'+(x.detail?'<div class="detail">'+esc(x.detail)+'</div>':'')+'</article>').join('');$('logs').innerHTML=logs||'<div class="empty">Chưa có hoạt động nào.</div>';}catch(e){$('service').textContent='MẤT KẾT NỐI';$('dot').className='dot bad';$('error').textContent=e.message;}}
  refresh();setInterval(refresh,3000);
  </script></body></html>`;
  res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store"});res.end(html);
});
server.listen(PORT,()=>console.log("HTTP:",PORT));if(KEEP_ALIVE_URL){setInterval(()=>{axios.get(KEEP_ALIVE_URL,{timeout:8000}).catch(()=>{})},10*60*1000)}setInterval(async()=>{for(const acc of REDEEM_ACCOUNTS){try{if(!acc.jwt||acc.jwtExp-Date.now()/1000<600)await acc.refreshToken()}catch{}}},240000);setInterval(()=>{if(redeemLogs.length>5000){redeemLogs=redeemLogs.slice(-4500);saveJson(REDEEM_LOGS_FILE,redeemLogs)}const keys=Object.keys(SEEN_ANNOUNCE);if(keys.length>200){for(const k of keys.slice(0,keys.length-100))delete SEEN_ANNOUNCE[k]}},15*60*1000);(async()=>{syncRedeemAccounts();markInterruptedRedeems();for(const acc of REDEEM_ACCOUNTS){try{await acc.refreshToken()}catch{}await new Promise((r)=>setTimeout(r,400))}const listenerOk=await startTeleListener();if(!listenerOk)bot.sendMessage(ADMIN_ID,"⚠️ <b>Chưa bật được canh kênh</b>\n"+esc(teleAuthStatus.error||"Chưa có session Telegram hoặc thiếu API ID/HASH. Vào TELEGRAM / KÊNH để đăng nhập lại."),{parse_mode:"HTML"}).catch(()=>{});console.log("✨",VERSION,`— READY · MODE=${redeemState.redeem_mode||"all"} · MAX_PARALLEL=${MAX_PARALLEL_ACCOUNTS} · WINDOW=${AUTO_REDEEM_WINDOW_MS/60000}m · TIN2_GLOBAL_STOP`)})();