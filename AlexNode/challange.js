function findFirstRecurring(array){
    hashmap ={}

    for (let i = 0; i < array.length; i++){
       hashmap[array[i]] = array[i]
       if( hashmap[array[i]] == array[i]){
        return array[i]
       }else{
        

       }
       return undefined
    }
}