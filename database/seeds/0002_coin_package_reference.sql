-- Reference recharge tiers only. Disabled and unpriced pending product-owner approval.
insert into coin_packages(id,coins,amount_usd,enabled,sort_order) values
('starter-01',100,null,false,10),('starter-02',500,null,false,20),('plus-01',1000,null,false,30),
('plus-02',2500,null,false,40),('pro-01',5000,null,false,50),('pro-02',10000,null,false,60),
('elite-01',25000,null,false,70)
on conflict(id) do nothing;
