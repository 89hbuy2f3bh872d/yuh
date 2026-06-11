import { HouseEdge } from "../src/HouseEdge.mjs";
import { COLORS } from "../src/theme.mjs";
const SUITS=["♠","♥","♦","♣"],VALUES=["A","2","3","4","5","6","7","8","9","10","J","Q","K"];
function newDeck(){const d=[];for(const s of SUITS)for(const v of VALUES)d.push({s,v});for(let i=d.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[d[i],d[j]]=[d[j],d[i]];}return d;}
function cv(c){if(["J","Q","K"].includes(c.v))return 10;if(c.v==="A")return 11;return parseInt(c.v);}
function ht(h){let t=h.reduce((s,c)=>s+cv(c),0),a=h.filter(c=>c.v==="A").length;while(t>21&&a>0){t-=10;a--;}return t;}
function fmt(h){return h.map(c=>`${c.v}${c.s}`).join(" ");}
const sessions=new Map();
export default {
  name:"blackjack",aliases:["bj"],
  description:"Blackjack. `&bj <bet>` then `&bj hit/stand/double`",
  async execute({message,args,db,embed,prefix}){
    const uid=message.author.id,sub=args[0]?.toLowerCase(),p=prefix;
    if(!sessions.has(uid)||!["hit","stand","double","h","s","d"].includes(sub)){
      const bet=parseInt(sub),u=await db.getUser(uid);
      if(isNaN(bet)||bet<=0)return message.channel.send({embeds:[embed(COLORS.error).setDescription(`❌ e.g. \`${p}bj 500\``)]});
      if(bet>u.bal)return message.channel.send({embeds:[embed(COLORS.error).setDescription("❌ Insufficient FC.")]});
      if(bet>500000)return message.channel.send({embeds:[embed(COLORS.error).setDescription("❌ Max 500,000 FC.")]});
      const deck=newDeck(),player=[deck.pop(),deck.pop()],dealer=[deck.pop(),deck.pop()];
      sessions.set(uid,{deck,player,dealer,bet,doubled:false});
      if(ht(player)===21){
        sessions.delete(uid);const payout=Math.floor(bet*1.5);
        await db.updateBalance(uid,payout);await db.recordGame(uid,true,bet+payout);
        return message.channel.send({embeds:[embed(COLORS.gold).setTitle("🃏 NATURAL 21! 🎉").setDescription(`**${fmt(player)}** (21)\n+**${payout.toLocaleString()} FC**\n${HouseEdge.baitWin()}`)]});
      }
      return message.channel.send({embeds:[embed(COLORS.accent).setTitle("🃏 Blackjack").setDescription(`Your hand: **${fmt(player)}** (${ht(player)})\nDealer shows: **${fmt([dealer[0]])}**\n\n\`${p}bj hit\` · \`${p}bj stand\` · \`${p}bj double\``)]});
    }
    const sess=sessions.get(uid),{deck,player,dealer,bet}=sess;
    if(["hit","h","double","d"].includes(sub)){
      if(["double","d"].includes(sub)){const u=await db.getUser(uid);if(u.bal<bet)return message.channel.send({embeds:[embed(COLORS.error).setDescription("❌ Not enough FC to double.")]});sess.bet=bet*2;sess.doubled=true;}
      player.push(deck.pop());const pt=ht(player);
      if(pt>21){sessions.delete(uid);await db.updateBalance(uid,-sess.bet);await db.recordGame(uid,false,sess.bet);return message.channel.send({embeds:[embed(COLORS.error).setTitle("🃏 BUST").setDescription(`**${fmt(player)}** (${pt})\n-**${sess.bet.toLocaleString()} FC**\n${HouseEdge.baitLoss()}`)]}});}
      if(!sess.doubled)return message.channel.send({embeds:[embed(COLORS.accent).setTitle("🃏 Blackjack").setDescription(`Your hand: **${fmt(player)}** (${pt})\nDealer shows: **${fmt([dealer[0]])}**\n\n\`${prefix}bj hit\` · \`${prefix}bj stand\``)]});
    }
    if(["stand","s"].includes(sub)||sess.doubled){
      sessions.delete(uid);
      while(ht(dealer)<17)dealer.push(deck.pop());
      const pt=ht(player),dt=ht(dealer),won=pt>dt||dt>21,push=pt===dt;
      if(push)return message.channel.send({embeds:[embed(COLORS.warn).setTitle("🃏 PUSH").setDescription(`You: **${fmt(player)}** (${pt}) | Dealer: **${fmt(dealer)}** (${dt})\nBet returned.`)]});
      if(won){await db.updateBalance(uid,sess.bet);await db.recordGame(uid,true,sess.bet*2);message.channel.send({embeds:[embed(COLORS.primary).setTitle("🃏 WIN!").setDescription(`You: **${fmt(player)}** (${pt}) | Dealer: **${fmt(dealer)}** (${dt})\n+**${sess.bet.toLocaleString()} FC**\n${HouseEdge.baitWin()}`)]}});}
      else{await db.updateBalance(uid,-sess.bet);await db.recordGame(uid,false,sess.bet);message.channel.send({embeds:[embed(COLORS.error).setTitle("🃏 LOSS").setDescription(`You: **${fmt(player)}** (${pt}) | Dealer: **${fmt(dealer)}** (${dt})\n-**${sess.bet.toLocaleString()} FC**\n${HouseEdge.baitLoss()}`)]}});}
    }
  }
};
