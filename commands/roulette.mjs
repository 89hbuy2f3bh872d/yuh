import { HouseEdge } from "../src/HouseEdge.mjs";
import { COLORS } from "../src/theme.mjs";
const RED=[1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36];
export default {
  name:"roulette",aliases:["rl"],
  description:"Roulette. `&rl <bet> <red|black|even|odd|1-36>`",
  async execute({message,args,db,embed,prefix}){
    const uid=message.author.id,bet=parseInt(args[0]),pick=args[1]?.toLowerCase(),u=await db.getUser(uid);
    const valid=["red","black","even","odd"],numPick=parseInt(pick);
    if(isNaN(bet)||bet<=0||(!valid.includes(pick)&&(isNaN(numPick)||numPick<1||numPick>36)))return message.channel.send({embeds:[embed(COLORS.error).setDescription(`❌ Usage: \`${prefix}rl <bet> <red|black|even|odd|1-36>\``)]});
    if(bet>u.bal)return message.channel.send({embeds:[embed(COLORS.error).setDescription("❌ Insufficient FC.")]});
    if(bet>750000)return message.channel.send({embeds:[embed(COLORS.error).setDescription("❌ Max 750,000 FC.")]});
    const s=Math.floor(Math.random()*37),isRed=RED.includes(s),color=s===0?"🟢":isRed?"🔴":"⚫";
    let won=false,mult=2;
    if(!isNaN(numPick)){won=s===numPick;mult=36;}
    else if(pick==="red"){won=s!==0&&isRed;}else if(pick==="black"){won=s!==0&&!isRed;}else if(pick==="even"){won=s!==0&&s%2===0;}else if(pick==="odd"){won=s!==0&&s%2!==0;}
    if(won){const payout=Math.floor(bet*(mult-1));await db.updateBalance(uid,payout);await db.recordGame(uid,true,bet+payout);return message.channel.send({embeds:[embed(COLORS.primary).setTitle("🎡 WIN!").setDescription(`${color} **${s}** — you bet **${pick}**!\n+**${payout.toLocaleString()} FC**\n${HouseEdge.baitWin()}`)]}});}
    else{await db.updateBalance(uid,-bet);await db.recordGame(uid,false,bet);return message.channel.send({embeds:[embed(COLORS.error).setTitle("🎡 LOSS").setDescription(`${color} **${s}** — you bet **${pick}**.\n-**${bet.toLocaleString()} FC**\n${HouseEdge.baitLoss()}`)]}});}
  }
};
