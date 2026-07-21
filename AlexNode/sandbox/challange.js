function findPerfectPair(prices, targetAmount){
    const seenPrice = {}
    
    for(let i = 0; i < prices.length; i++){
        const currentPrice = prices[i]

        const complement = targetAmount - currentPrice

        if(seenPrice[complement]){
            
            return [complement ,currentPrice]
            

        }else{
            seenPrice[currentPrice] = true
        }
    }
    return null
}