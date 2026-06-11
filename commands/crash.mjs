import { HouseEdge } from "../src/HouseEdge.mjs";
import { COLORS } from "../src/theme.mjs";
export default {
  name:"crash",aliases:["cr"],
  description:"Crash game. `&crash <bet> <cashout e.g. 2.5>`",
  async execute({message,args,db,embed,prefix}){
    const uid=message.author.id,bet=parseInt(args[0]),target=parseFloat(args[1]),u=await db.getUser(uid);
    if(isNaN(bet)||bet<=0||isNaN(target)||target<1.01)return message.channel.send({embeds:[embed(COLORS.error).setDescription(`❌ Usage: \`${prefix}crash <bet> <cashout>\``)]});
    if(bet>u.bal)return message.channel.send({embeds:[embed(COLORS.error).setDescription("❌ Insufficient FC.")]});
    if(bet>2000000)return message.channel.send({embeds:[embed(COLORS.error).setDescription("❌ Max 2,000,000 FC.")]});
    const crashAt=Math.random()<0.07?1.0:Math.max(1.0,0.99/Math.random());
    const rc=Math.floor(crashAt*100)/100;
    if(target<=rc){const win=Math.floor(bet*target)-bet;await db.updateBalance(uid,win);await db.recordGame(uid,true,bet+win);return message.channel.send({embeds:[embed(COLORS.primary).setTitle("📈 CASHED OUT!").setDescription(`Cashed at **${target}x** before crash at **${rc}x**\n+**${win.toLocaleString()} FC**\n${HouseEdge.baitWin()}`)]}});}
    else{await db.updateBalance(uid,-bet);await db.recordGame(uid,false,bet);return message.channel.send({embeds:[embed(COLORS.error).setTitle("📉 BUSTED").setDescription(`Crashed at **${rc}x** before your **${target}x**.\n-**${bet.toLocaleString()} FC**\n${HouseEdge.baitLoss()}`)]}});}
  }
};
