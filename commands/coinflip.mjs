import { HouseEdge } from "../src/HouseEdge.mjs";
import { COLORS } from "../src/theme.mjs";
export default {
  name:"coinflip",aliases:["cf","flip"],
  description:"Coin flip. `&cf <bet> <heads|tails>`",
  async execute({message,args,db,embed,prefix}){
    const uid=message.author.id,bet=parseInt(args[0]),side=args[1]?.toLowerCase(),u=await db.getUser(uid);
    if(isNaN(bet)||bet<=0||!["heads","tails","h","t"].includes(side))return message.channel.send({embeds:[embed(COLORS.error).setDescription(`❌ Usage: \`${prefix}cf <bet> <heads|tails>\``)]});
    if(bet>u.bal)return message.channel.send({embeds:[embed(COLORS.error).setDescription("❌ Insufficient FC.")]});
    if(bet>500000)return message.channel.send({embeds:[embed(COLORS.error).setDescription("❌ Max 500,000 FC.")]});
    const result=Math.random()<0.475===["heads","h"].includes(side)?"heads":"tails";
    const correct=(["heads","h"].includes(side)&&result==="heads")||(["tails","t"].includes(side)&&result==="tails");
    const coin=result==="heads"?"🪙":"🌑";
    if(correct){await db.updateBalance(uid,bet);await db.recordGame(uid,true,bet*2);return message.channel.send({embeds:[embed(COLORS.primary).setTitle(`${coin} WIN!`).setDescription(`Landed **${result}**! +**${bet.toLocaleString()} FC**\n${HouseEdge.baitWin()}`)]}});}
    else{await db.updateBalance(uid,-bet);await db.recordGame(uid,false,bet);return message.channel.send({embeds:[embed(COLORS.error).setTitle(`${coin} LOSS`).setDescription(`Landed **${result}**. -**${bet.toLocaleString()} FC**\n${HouseEdge.baitLoss()}`)]}});}
  }
};
