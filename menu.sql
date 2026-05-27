-- 1. Insert Categories with mapped icons and capture their generated UUIDs
WITH inserted_categories AS (
    INSERT INTO public.menu_categories (id, tenant_id, "name", sort, is_active, color, created_at, updated_at, deleted_at, icon)
    VALUES 
        (gen_random_uuid(), '5bf1bdaf-6d1b-479e-b384-c59cd9b0fc44', 'Alternatives', 1, true, '', now(), now(), null, 'CupSoda'),
        (gen_random_uuid(), '5bf1bdaf-6d1b-479e-b384-c59cd9b0fc44', 'Cold Beverages', 2, true, '', now(), now(), null, 'Coffee'),
        (gen_random_uuid(), '5bf1bdaf-6d1b-479e-b384-c59cd9b0fc44', 'Hot Beverages', 3, true, '', now(), now(), null, 'Coffee'),
        (gen_random_uuid(), '5bf1bdaf-6d1b-479e-b384-c59cd9b0fc44', 'Snacks', 4, true, '', now(), now(), null, 'Utensils'),
        (gen_random_uuid(), '5bf1bdaf-6d1b-479e-b384-c59cd9b0fc44', 'Tea', 5, true, '', now(), now(), null, 'CupSoda'),
        (gen_random_uuid(), '5bf1bdaf-6d1b-479e-b384-c59cd9b0fc44', 'Boba', 6, true, '', now(), now(), null, 'Milk'),
        (gen_random_uuid(), '5bf1bdaf-6d1b-479e-b384-c59cd9b0fc44', 'Matcha', 7, true, '', now(), now(), null, 'Leaf'),
        (gen_random_uuid(), '5bf1bdaf-6d1b-479e-b384-c59cd9b0fc44', 'Special Drinks', 8, true, '', now(), now(), null, 'Martini'),
        (gen_random_uuid(), '5bf1bdaf-6d1b-479e-b384-c59cd9b0fc44', 'Cigarettes', 9, true, '', now(), now(), null, 'Flame'),
        (gen_random_uuid(), '5bf1bdaf-6d1b-479e-b384-c59cd9b0fc44', 'Hookah', 10, true, '', now(), now(), null, 'Flame'),
        (gen_random_uuid(), '5bf1bdaf-6d1b-479e-b384-c59cd9b0fc44', 'Cookies', 11, true, '', now(), now(), null, 'Cookie'),
        (gen_random_uuid(), '5bf1bdaf-6d1b-479e-b384-c59cd9b0fc44', 'Bakery', 12, true, '', now(), now(), null, 'Croissant')
    RETURNING id, "name"
)

-- 2. Map items to their respective category dynamically, attaching unique SKUs and icons
INSERT INTO public.menu_items 
(id, tenant_id, category_id, "name", description, price_cents, cost_cents, sku, image_url, is_active, modifiers, sort, created_at, updated_at, deleted_at, preset_notes, icon, is_featured)
SELECT 
    gen_random_uuid(), 
    '5bf1bdaf-6d1b-479e-b384-c59cd9b0fc44', 
    c.id, 
    item_data."name", 
    ''::text, 
    item_data.price_cents, 
    0, 
    item_data.sku, 
    '', true, '{}'::jsonb, 
    item_data.sort, 
    now(), now(), null, '{}'::text[], 
    item_data.icon, -- Injected icon per item
    false
FROM inserted_categories c
JOIN (
    VALUES
        -- Alternatives
        ('Alternatives', 'Peach Iced Tea', 16000, 1, 'ALT-PEACH-ICED-TEA', 'CupSoda'),
        ('Alternatives', 'Virgin Mojito', 18000, 2, 'ALT-VIRGIN-MOJITO', 'Citrus'),
        ('Alternatives', 'Lemonade', 10000, 3, 'ALT-LEMONADE', 'Citrus'),
        ('Alternatives', 'Fresh lemon soda', 12000, 4, 'ALT-FRESH-LEMON-SODA', 'CupSoda'),
        ('Alternatives', 'Plain lassi', 12000, 5, 'ALT-PLAIN-LASSI', 'Milk'),
        ('Alternatives', 'Banana lassi', 15000, 6, 'ALT-BANANA-LASSI', 'Milk'),
        ('Alternatives', 'Coke/Fanta/Sprite', 7000, 7, 'ALT-SODA-MIX', 'CupSoda'),

        -- Cold Beverages
        ('Cold Beverages', 'Americano', 16000, 1, 'COLD-AMERICANO', 'Coffee'),
        ('Cold Beverages', 'Latte', 19500, 2, 'COLD-LATTE', 'Coffee'),
        ('Cold Beverages', 'Mocha', 23500, 3, 'COLD-MOCHA', 'Coffee'),
        ('Cold Beverages', 'Mocha Madness', 34500, 4, 'COLD-MOCHA-MADNESS', 'Coffee'),
        ('Cold Beverages', 'Caramel Macchiato', 24500, 5, 'COLD-CARAMEL-MACCHIATO', 'Coffee'),

        -- Hot Beverages
        ('Hot Beverages', 'Espresso', 10000, 1, 'HOT-ESPRESSO', 'Coffee'),
        ('Hot Beverages', 'Doppio', 13000, 2, 'HOT-DOPPIO', 'Coffee'),
        ('Hot Beverages', 'Americano (Single)', 12000, 3, 'HOT-AMERICANO-S', 'Coffee'),
        ('Hot Beverages', 'Americano (Double)', 15000, 4, 'HOT-AMERICANO-D', 'Coffee'),
        ('Hot Beverages', 'Cappuccino', 14000, 5, 'HOT-CAPPUCCINO', 'Coffee'),
        ('Hot Beverages', 'Café Latte', 15000, 6, 'HOT-LATTE', 'Coffee'),
        ('Hot Beverages', 'Café Mocha', 19500, 7, 'HOT-MOCHA', 'Coffee'),
        ('Hot Beverages', 'Hot chocolate', 18000, 8, 'HOT-CHOCOLATE', 'Coffee'),

        -- Snacks
        ('Snacks', 'Veg Sandwich', 10000, 1, 'SNK-VEG-SANDWICH', 'Sandwich'),
        ('Snacks', 'Egg Sandwich', 12000, 2, 'SNK-EGG-SANDWICH', 'Egg'),
        ('Snacks', 'Chicken Sandwich', 14000, 3, 'SNK-CHICKEN-SANDWICH', 'Sandwich'),
        ('Snacks', 'Add-on cheese', 5000, 4, 'SNK-ADD-CHEESE', 'Cake'),
        ('Snacks', 'ChauChau Sadheko', 10000, 5, 'SNK-CHAUCHAU-SADHEKO', 'CookingPot'),
        ('Snacks', 'Buff Sausage', 4000, 6, 'SNK-BUFF-SAUSAGE', 'Drumstick'),
        ('Snacks', 'Chicken sausage', 6000, 7, 'SNK-CHICKEN-SAUSAGE', 'Drumstick'),
        ('Snacks', 'Veg MoMo', 11000, 8, 'SNK-VEG-MOMO', 'CookingPot'),
        ('Snacks', 'Buff MoMo', 12000, 9, 'SNK-BUFF-MOMO', 'CookingPot'),
        ('Snacks', 'Chicken MoMo', 14000, 10, 'SNK-CHICKEN-MOMO', 'CookingPot'),

        -- Tea
        ('Tea', 'Milk Tea', 3000, 1, 'TEA-MILK', 'CupSoda'),
        ('Tea', 'Masala Milk Tea', 4500, 2, 'TEA-MASALA', 'CupSoda'),
        ('Tea', 'Black Tea', 2500, 3, 'TEA-BLACK', 'CupSoda'),
        ('Tea', 'Lemon Tea', 4000, 4, 'TEA-LEMON', 'Citrus'),
        ('Tea', 'Hot lemon', 4000, 5, 'TEA-HOT-LEMON', 'Citrus'),
        ('Tea', 'Hot lemon (w honey & ginger)', 12000, 6, 'TEA-HOT-LEMON-HG', 'Flame'),
        ('Tea', 'Peach tea', 7000, 7, 'TEA-PEACH', 'CupSoda'),

        -- Boba
        ('Boba', 'Chocolate Boba Tea', 24000, 1, 'BBA-CHOCOLATE', 'Milk'),
        ('Boba', 'Strawberry Boba Tea', 25000, 2, 'BBA-STRAWBERRY', 'Milk'),
        ('Boba', 'Blueberry Boba Tea', 27000, 3, 'BBA-BLUEBERRY', 'Milk'),
        ('Boba', 'Coffee Boba Tea', 23000, 4, 'BBA-COFFEE', 'Coffee'),

        -- Matcha
        ('Matcha', 'Iced Matcha Latte', 25000, 1, 'MTC-ICED-LATTE', 'Leaf'),
        ('Matcha', 'Matcha Latte (Single w/o honey)', 24000, 2, 'MTC-LATTE-S', 'Leaf'),
        ('Matcha', 'Matcha Latte (Double w/o honey)', 31000, 3, 'MTC-LATTE-D', 'Leaf'),

        -- Special Drinks
        ('Special Drinks', 'Pink Cloud', 28000, 1, 'SPC-PINK-CLOUD', 'Sparkles'),
        ('Special Drinks', 'Blueberry Mojito', 25000, 2, 'SPC-BLUEBERRY-MOJITO', 'Martini'),
        ('Special Drinks', 'Blueberry Iced Tea', 25000, 3, 'SPC-BLUEBERRY-TEA', 'CupSoda'),
        ('Special Drinks', 'Blue Lagoon', 27000, 4, 'SPC-BLUE-LAGOON', 'Martini'),

        -- Cigarettes
        ('Cigarettes', 'Surya Red', 2500, 1, 'CIG-SURYA-RED', 'Flame'),
        ('Cigarettes', 'Surya Lite', 2500, 2, 'CIG-SURYA-LITE', 'Flame'),
        ('Cigarettes', 'Surya Fusion', 2500, 3, 'CIG-SURYA-FUSION', 'Flame'),
        ('Cigarettes', 'Surya Artic', 3000, 4, 'CIG-SURYA-ARTIC', 'Snowflake'),
        ('Cigarettes', 'Surya Rich', 2500, 5, 'CIG-SURYA-RICH', 'Flame'),
        ('Cigarettes', 'Surya Sleek Bolt', 2500, 6, 'CIG-SURYA-BOLT', 'Zap'),
        ('Cigarettes', 'Sikhar Ice', 2500, 7, 'CIG-SIKHAR-ICE', 'Snowflake'),

        -- Hookah
        ('Hookah', 'Normal', 30000, 1, 'HOK-NORMAL', 'Flame'),
        ('Hookah', 'Cloud', 45000, 2, 'HOK-CLOUD', 'Flame'),
        ('Hookah', 'Premium', 70000, 3, 'HOK-PREMIUM', 'Crown'),
        ('Hookah', 'Normal Coil', 4000, 4, 'HOK-NORMAL-COIL', 'Zap'),
        ('Hookah', 'Coconut Coil', 6000, 5, 'HOK-COCONUT-COIL', 'Zap'),

        -- Cookies
        ('Cookies', 'Oat Cookie', 3000, 1, 'CK-OAT', 'Cookie'),
        ('Cookies', 'Coconut Cookie', 2500, 2, 'CK-COCONUT', 'Cookie'),
        ('Cookies', 'Jira Cookie (2 pcs)', 2500, 3, 'CK-JIRA-2PCS', 'Cookie'),
        ('Cookies', 'Jira Cookie (1 pc)', 1500, 4, 'CK-JIRA-1PC', 'Cookie'),

        -- Bakery
        ('Bakery', 'Muffin', 3000, 1, 'BKR-MUFFIN', 'Cake'),
        ('Bakery', 'Chocolate Doughnut (white/chocolate)', 5000, 2, 'BKR-CHOC-DONUT', 'Donut'),
        ('Bakery', 'Cream Doughnut', 4000, 3, 'BKR-CREAM-DONUT', 'Donut'),
        ('Bakery', 'Doughnut', 3000, 4, 'BKR-PLAIN-DONUT', 'Donut')
) AS item_data(cat_name, "name", price_cents, sort, sku, icon)
ON c."name" = item_data.cat_name;