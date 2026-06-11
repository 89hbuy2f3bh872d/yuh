import { HouseEdge } from "../src/HouseEdge.mjs";
import { COLORS } from "../src/theme.mjs";
const REELS=["🍒","🍋","🍊","🍇","💎","7️⃣","🔔","⭐"];
const WEIGHTS=[30,25,20,15,5,3,1,1];
const PAYOUTS={"🍒":1.5,"🍋":1.8,"🍊":2.2,"🍇":2.5,"💎":5,"7️⃣":8,"🔔":6,"⭐":4};
function spin(){let r=Math.random()*100;for(let i=0;i<REELS.length;i++){r-=WEIGHTS[i];if(r<=0)return REELS[i];}return REELS[0];}
export default {
  name:"slots",aliases:["sl","slot"],
  description:"Spin the slots. `&slots <bet>`",
  async execute({message,args,db,embed,prefix}){
    const uid=message.author.id,bet=parseInt(args[0]),u=await db.getUser(uid);
    if(isNaN(bet)||bet<=0)return message.channel.send({embeds:[embed(COLORS.error).setDescription(`❌ Usage: \`${prefix}slots <bet>\``)]});
    if(bet>u.bal)return message.channel.send({embeds:[embed(COLORS.error).setDescription("❌ Insufficient FC.")]});
    if(bet>1000000)return message.channel.send({embeds:[embed(COLORS.error).setDescription("❌ Max 1,000,000 FC.")]});
    const reels=[spin(),spin(),spin()],display=reels.join(" | "),[a,b,c]=reels;
    if(a===b&&b===c){const mult=PAYOUTS[a]??2,win=Math.floor(bet*mult*0.92);await db.updateBalance(uid,win);await db.recordGame(uid,true,bet+win);return message.channel.send({embeds:[embed(COLORS.gold).setTitle("🎰 JACKPOT!").setDescription(`**[ ${display} ]**\n+**${win.toLocaleString()} FC** (${mult}x)\n${HouseEdge.baitWin()}`)]}});}
    else if(a===b||b===c||a===c){const win=Math.floor(bet*0.5);await db.updateBalance(uid,win);await db.recordGame(uid,true,bet+win);return message.channel.send({embeds:[embed(COLORS.accent).setTitle("🎰 Partial Win").setDescription(`**[ ${display} ]**\n+**${win.toLocaleString()} FC**\n${HouseEdge.baitWin()}`)]}});}
    else{await db.updateBalance(uid,-bet);await db.recordGame(uid,false,bet);return message.channel.send({embeds:[embed(COLORS.error).setTitle("🎰 No Match").setDescription(`**[ ${display} ]**\n-**${bet.toLocaleString()} FC**\n${HouseEdge.baitLoss()}`)]}});}
  }
};
